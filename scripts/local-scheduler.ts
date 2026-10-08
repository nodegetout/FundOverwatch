import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import rawCalendar from "../data/calendars/cn-exchange.json";

const execFile = promisify(execFileCallback);
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_GRACE_MINUTES = 15;
const DEFAULT_SCAN_DAYS = 3;
const MAX_BACKFILL_DAYS = 7;
const MAX_ATTEMPTS = 5;
const LOCK_STALE_MS = 15 * 60 * 1000;

export type SchedulerPhase = "morning" | "evening";
export type SlotStateStatus =
  | "pending"
  | "observed"
  | "dispatched"
  | "success"
  | "failed"
  | "skipped";

export interface SchedulerConfig {
  repository: string;
  workflow: string;
  ref: string;
  ghPath: string;
  stateFile: string;
  lockDirectory: string;
  graceMinutes: number;
  scanDays: number;
  maxBackfillDays: number;
  sourceCommit: string;
}

export interface ExpectedSlot {
  key: string;
  date: string;
  phase: SchedulerPhase;
  scheduledAt: string;
  scheduledAtMs: number;
  reason: string;
}

export interface WorkflowRun {
  id: number;
  event: "schedule" | "workflow_dispatch" | string;
  created_at: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  html_url: string;
}

export interface SlotRecord {
  key: string;
  date: string;
  phase: SchedulerPhase;
  scheduledAt: string;
  status: SlotStateStatus;
  decision: string;
  attempts: number;
  lastCheckedAt: string;
  nextAttemptAt: string | null;
  dispatchRequestedAt: string | null;
  dispatchRunId: number | null;
  dispatchRunUrl: string | null;
  error: string | null;
}

export interface SchedulerState {
  schemaVersion: 1;
  sourceCommit: string;
  lastRunAt: string | null;
  lastSuccessfulCheckAt: string | null;
  slots: Record<string, SlotRecord>;
}

export interface SchedulerDependencies {
  now: () => Date;
  listRuns: (createdAfter: string) => Promise<WorkflowRun[]>;
  dispatch: (phase: SchedulerPhase, date: string) => Promise<void>;
  resolveDispatchRun: (requestedAt: string) => Promise<WorkflowRun | null>;
  log: (message: string) => void;
}

interface CliOptions {
  dryRun: boolean;
  status: boolean;
  date?: string;
  backfill?: { start: string; end: string };
  configPath?: string;
}

function isoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function shanghaiDate(now: Date): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function calendarDecision(date: string): { status: "trading" | "closed" | "unavailable"; reason: string } {
  const day = weekday(date);
  if (day === 0 || day === 6) return { status: "closed", reason: "周末休市" };
  const year = rawCalendar.years.find(({ year: value }) => value === Number(date.slice(0, 4)));
  if (!year) return { status: "unavailable", reason: "calendar-unavailable" };
  const closure = year.closures.find(({ date: value }) => value === date);
  return closure
    ? { status: "closed", reason: `${closure.reason}休市` }
    : { status: "trading", reason: "SSE/SZSE trading day" };
}

function scheduledAt(date: string, phase: SchedulerPhase): { iso: string; milliseconds: number } {
  const time = phase === "morning" ? "10:30:00" : "22:30:00";
  const iso = `${date}T${time}+08:00`;
  return { iso, milliseconds: Date.parse(iso) };
}

export function expectedSlots(startDate: string, endDate: string): ExpectedSlot[] {
  const slots: ExpectedSlot[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    const decision = calendarDecision(date);
    if (decision.status === "unavailable") continue;
    if (decision.status === "trading") {
      const schedule = scheduledAt(date, "morning");
      slots.push({
        key: `${date}:morning`,
        date,
        phase: "morning",
        scheduledAt: schedule.iso,
        scheduledAtMs: schedule.milliseconds,
        reason: decision.reason
      });
    }
    const day = weekday(date);
    if (day >= 1 && day <= 5) {
      const schedule = scheduledAt(date, "evening");
      slots.push({
        key: `${date}:evening`,
        date,
        phase: "evening",
        scheduledAt: schedule.iso,
        scheduledAtMs: schedule.milliseconds,
        reason:
          day === 5
            ? `${decision.reason}; Friday weekly close and period completion`
            : `${decision.reason}; NAV evaluation and period completion`
      });
    }
  }
  return slots;
}

export function emptyState(sourceCommit: string): SchedulerState {
  return {
    schemaVersion: 1,
    sourceCommit,
    lastRunAt: null,
    lastSuccessfulCheckAt: null,
    slots: {}
  };
}

export async function loadState(file: string, sourceCommit: string): Promise<SchedulerState> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(sourceCommit);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Scheduler state is corrupt JSON at ${file}: ${(error as Error).message}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (parsed as { slots?: unknown }).slots !== "object"
  ) {
    throw new Error(`Scheduler state has an unsupported schema at ${file}.`);
  }
  return parsed as SchedulerState;
}

export async function saveState(file: string, state: SchedulerState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function acquireLock(
  directory: string,
  now = new Date(),
  staleMilliseconds = LOCK_STALE_MS
): Promise<() => Promise<void>> {
  await mkdir(path.dirname(directory), { recursive: true });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const metadata = await stat(directory);
    if (now.getTime() - metadata.mtimeMs <= staleMilliseconds) {
      throw new Error(`Scheduler lock is already held: ${directory}`);
    }
    await rm(directory, { recursive: true });
    await mkdir(directory, { mode: 0o700 });
  }
  const owner = await open(path.join(directory, "owner.json"), "wx", 0o600);
  await owner.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: now.toISOString() }));
  await owner.close();
  return async () => {
    await rm(directory, { recursive: true });
  };
}

function retryDelayMilliseconds(attempts: number): number {
  return Math.min(60, 5 * 2 ** Math.max(0, attempts - 1)) * 60 * 1000;
}

function matchingObservedRun(
  slot: ExpectedSlot,
  runs: WorkflowRun[],
  graceMinutes: number
): WorkflowRun | null {
  const lower = slot.scheduledAtMs - 5 * 60 * 1000;
  const upper = slot.scheduledAtMs + graceMinutes * 60 * 1000;
  return (
    runs.find((run) => {
      const created = Date.parse(run.created_at);
      return (
        run.event === "schedule" &&
        run.head_branch === "main" &&
        created >= lower &&
        created <= upper
      );
    }) ?? null
  );
}

function recordFor(slot: ExpectedSlot, now: Date): SlotRecord {
  return {
    key: slot.key,
    date: slot.date,
    phase: slot.phase,
    scheduledAt: slot.scheduledAt,
    status: "pending",
    decision: "pending",
    attempts: 0,
    lastCheckedAt: now.toISOString(),
    nextAttemptAt: null,
    dispatchRequestedAt: null,
    dispatchRunId: null,
    dispatchRunUrl: null,
    error: null
  };
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/gho_[A-Za-z0-9_]+/g, "[REDACTED]").slice(0, 500);
}

export async function runScheduler(
  config: SchedulerConfig,
  state: SchedulerState,
  dependencies: SchedulerDependencies,
  options: Pick<CliOptions, "dryRun" | "date" | "backfill">
): Promise<SchedulerState> {
  const now = dependencies.now();
  const today = shanghaiDate(now);
  const startDate = options.backfill?.start ?? options.date ?? addDays(today, -(config.scanDays - 1));
  const endDate = options.backfill?.end ?? options.date ?? today;
  if (!isoDate(startDate) || !isoDate(endDate) || startDate > endDate) {
    throw new Error(`Invalid scheduler date range ${startDate}..${endDate}.`);
  }
  const oldest = addDays(today, -config.maxBackfillDays);
  if (startDate < oldest) {
    throw new Error(
      `Backfill start ${startDate} exceeds the ${config.maxBackfillDays}-day automatic limit (${oldest}).`
    );
  }
  state.lastRunAt = now.toISOString();
  const runs = await dependencies.listRuns(
    new Date(Date.parse(`${startDate}T00:00:00+08:00`) - 10 * 60 * 1000).toISOString()
  );
  for (const slot of expectedSlots(startDate, endDate)) {
    const graceAt = slot.scheduledAtMs + config.graceMinutes * 60 * 1000;
    if (now.getTime() < graceAt) continue;
    const record = state.slots[slot.key] ?? recordFor(slot, now);
    record.lastCheckedAt = now.toISOString();
    state.slots[slot.key] = record;

    if (record.dispatchRunId) {
      const run = runs.find(({ id }) => id === record.dispatchRunId);
      if (run?.status === "completed" && run.conclusion === "success") {
        record.status = "success";
        record.decision = "dispatch-success";
        record.nextAttemptAt = null;
        record.error = null;
        dependencies.log(
          `slot=${slot.key} decision=success run=${run.html_url}`
        );
        continue;
      }
      if (run?.status !== "completed") {
        record.status = "dispatched";
        record.decision = "dispatch-running";
        dependencies.log(`slot=${slot.key} decision=observed-dispatch run=${run?.html_url ?? record.dispatchRunUrl}`);
        continue;
      }
      record.status = "failed";
      record.decision = `dispatch-${run.conclusion ?? "failed"}`;
      record.error = `Workflow run concluded ${run.conclusion ?? "without a conclusion"}.`;
      if (!record.nextAttemptAt) {
        record.nextAttemptAt = new Date(
          now.getTime() + retryDelayMilliseconds(record.attempts)
        ).toISOString();
        dependencies.log(`slot=${slot.key} decision=retry-backoff until=${record.nextAttemptAt}`);
        continue;
      }
      if (Date.parse(record.nextAttemptAt) > now.getTime()) {
        dependencies.log(`slot=${slot.key} decision=retry-backoff until=${record.nextAttemptAt}`);
        continue;
      }
      record.dispatchRunId = null;
      record.dispatchRunUrl = null;
      record.nextAttemptAt = null;
    }

    if (record.status === "success" || record.status === "observed") continue;
    const observed = matchingObservedRun(slot, runs, config.graceMinutes);
    if (observed) {
      record.status =
        observed.status === "completed" && observed.conclusion === "success"
          ? "observed"
          : "pending";
      record.decision = "observed-schedule";
      record.dispatchRunId = observed.id;
      record.dispatchRunUrl = observed.html_url;
      dependencies.log(`slot=${slot.key} decision=observed run=${observed.html_url}`);
      continue;
    }
    if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now.getTime()) {
      dependencies.log(`slot=${slot.key} decision=retry-backoff until=${record.nextAttemptAt}`);
      continue;
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      record.status = "failed";
      record.decision = "retry-limit";
      dependencies.log(`slot=${slot.key} decision=skipped reason=retry-limit`);
      continue;
    }
    if (options.dryRun) {
      record.decision = "dry-run-dispatch";
      dependencies.log(
        `slot=${slot.key} phase=${slot.phase} date=${slot.date} decision=dry-run-dispatch reason="${slot.reason}"`
      );
      continue;
    }
    record.attempts += 1;
    record.dispatchRequestedAt = now.toISOString();
    record.status = "pending";
    record.decision = "dispatch-requested";
    try {
      await dependencies.dispatch(slot.phase, slot.date);
      const dispatched = await dependencies.resolveDispatchRun(record.dispatchRequestedAt);
      if (dispatched) {
        record.dispatchRunId = dispatched.id;
        record.dispatchRunUrl = dispatched.html_url;
        record.status = "dispatched";
        record.decision = "dispatched";
        record.nextAttemptAt = null;
        record.error = null;
        dependencies.log(`slot=${slot.key} decision=dispatch run=${dispatched.html_url}`);
      } else {
        record.nextAttemptAt = new Date(
          now.getTime() + retryDelayMilliseconds(record.attempts)
        ).toISOString();
        record.error = "Dispatch accepted but its workflow run was not observable yet.";
        dependencies.log(`slot=${slot.key} decision=dispatch-unconfirmed`);
      }
    } catch (error) {
      record.status = "failed";
      record.decision = "dispatch-error";
      record.error = safeError(error);
      record.nextAttemptAt = new Date(
        now.getTime() + retryDelayMilliseconds(record.attempts)
      ).toISOString();
      dependencies.log(`slot=${slot.key} decision=retry error="${record.error}"`);
    }
  }
  state.lastSuccessfulCheckAt = now.toISOString();
  return state;
}

async function gh(
  config: SchedulerConfig,
  arguments_: string[]
): Promise<string> {
  const environment = { ...process.env };
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  const result = await execFile(config.ghPath, arguments_, {
    maxBuffer: 10 * 1024 * 1024,
    env: { ...environment, GH_PAGER: "cat", NO_COLOR: "1" }
  });
  return result.stdout;
}

export function liveDependencies(config: SchedulerConfig): SchedulerDependencies {
  return {
    now: () => new Date(),
    log: (message) => console.log(`${new Date().toISOString()} ${message}`),
    listRuns: async (createdAfter) => {
      const encoded = encodeURIComponent(`>=${createdAfter}`);
      const output = await gh(config, [
        "api",
        `repos/${config.repository}/actions/workflows/${config.workflow}/runs?per_page=100&created=${encoded}`
      ]);
      return (JSON.parse(output) as { workflow_runs: WorkflowRun[] }).workflow_runs;
    },
    dispatch: async (phase, date) => {
      await gh(config, [
        "workflow",
        "run",
        config.workflow,
        "--repo",
        config.repository,
        "--ref",
        config.ref,
        "-f",
        `phase=${phase}`,
        "-f",
        `date=${date}`
      ]);
    },
    resolveDispatchRun: async (requestedAt) => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const output = await gh(config, [
          "api",
          `repos/${config.repository}/actions/workflows/${config.workflow}/runs?event=workflow_dispatch&per_page=20`
        ]);
        const runs = (JSON.parse(output) as { workflow_runs: WorkflowRun[] }).workflow_runs;
        const match = runs.find(
          (run) =>
            run.head_branch === config.ref &&
            Date.parse(run.created_at) >= Date.parse(requestedAt) - 5_000
        );
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      return null;
    }
  };
}

function defaultConfig(configPath?: string): SchedulerConfig {
  const home = os.homedir();
  return {
    repository: "nodegetout/FundOverwatch",
    workflow: "data-refresh.yml",
    ref: "main",
    ghPath: "gh",
    stateFile: path.join(home, "Library", "Application Support", "FundOverwatch", "scheduler-state.json"),
    lockDirectory: path.join(home, "Library", "Application Support", "FundOverwatch", "scheduler.lock"),
    graceMinutes: DEFAULT_GRACE_MINUTES,
    scanDays: DEFAULT_SCAN_DAYS,
    maxBackfillDays: MAX_BACKFILL_DAYS,
    sourceCommit: "development",
    ...(configPath ? { configPath } : {})
  } as SchedulerConfig;
}

async function readConfig(configPath?: string): Promise<SchedulerConfig> {
  if (!configPath) return defaultConfig();
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<SchedulerConfig>;
  return { ...defaultConfig(configPath), ...parsed };
}

function parseCli(arguments_: string[]): CliOptions {
  const value = (name: string) =>
    arguments_.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const date = value("date");
  if (date && !isoDate(date)) throw new Error(`Invalid --date=${date}.`);
  const backfillValue = value("backfill");
  let backfill: CliOptions["backfill"];
  if (backfillValue) {
    const [start, end] = backfillValue.split("..");
    if (!start || !end || !isoDate(start) || !isoDate(end)) {
      throw new Error("--backfill must be YYYY-MM-DD..YYYY-MM-DD.");
    }
    backfill = { start, end };
  }
  return {
    dryRun: arguments_.includes("--dry-run"),
    status: arguments_.includes("--status"),
    ...(date ? { date } : {}),
    ...(backfill ? { backfill } : {}),
    ...(value("config") ? { configPath: value("config") } : {})
  };
}

export function summarizeState(state: SchedulerState): Record<string, unknown> {
  const records = Object.values(state.slots);
  return {
    sourceCommit: state.sourceCommit,
    lastRunAt: state.lastRunAt,
    lastSuccessfulCheckAt: state.lastSuccessfulCheckAt,
    pendingSlots: records.filter(({ status }) =>
      ["pending", "dispatched", "failed"].includes(status)
    ),
    recentDispatches: records
      .filter(({ dispatchRequestedAt }) => dispatchRequestedAt)
      .sort((left, right) =>
        (right.dispatchRequestedAt ?? "").localeCompare(left.dispatchRequestedAt ?? "")
      )
      .slice(0, 10)
  };
}

async function ensureGhAccess(config: SchedulerConfig): Promise<void> {
  await gh(config, ["auth", "status", "--hostname", "github.com"]);
  const permission = JSON.parse(
    await gh(config, ["api", `repos/${config.repository}/actions/permissions`])
  ) as { enabled?: boolean };
  if (!permission.enabled) throw new Error(`GitHub Actions is disabled for ${config.repository}.`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const config = await readConfig(
    options.configPath ?? process.env.FUNDOVERWATCH_SCHEDULER_CONFIG
  );
  const state = await loadState(config.stateFile, config.sourceCommit);
  if (options.status) {
    console.log(JSON.stringify(summarizeState(state), null, 2));
    return;
  }
  await ensureGhAccess(config);
  const release = await acquireLock(config.lockDirectory);
  try {
    const next = await runScheduler(config, state, liveDependencies(config), options);
    await saveState(config.stateFile, next);
  } finally {
    await release();
  }
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    await main();
  } catch (error) {
    console.error(`${new Date().toISOString()} scheduler-error="${safeError(error)}"`);
    process.exitCode = 1;
  }
}
