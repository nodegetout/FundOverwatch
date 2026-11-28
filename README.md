# Fund Overwatch

Fund Overwatch 是面向 **8 只中国大陆真实公募基金**的可审计静态分析站。项目只使用公开真实数据，建立“上午预测—晚间评估—周期复盘—模型校准”闭环；没有生产 MockProvider、模拟市场或伪 AI。

## 能力与边界

- 上午以最新已披露持仓、可获得的股票/ETF 上午行情、已披露 NAV 动量和历史校准参数，预测下一可对齐净值的日收益与方向。
- 晚间按目标交易日匹配实际 NAV；净值尚未披露时记录 `pending`，后续晚间运行自动补评。
- 周/月/年报告提供样本数、方向准确率、MAE、RMSE、平均误差、缺失率及基金/置信度/覆盖率分组表现。
- `cn-baseline-v1` 是确定性、有界、可解释的实验基线。少于 20 个已评估样本时显示 `cold-start`，不宣称模型稳健。
- QDII、债券、场外基金或缺少可靠市场标识的资产不生成模拟行情；覆盖率与置信度会降低并显示原因。
- 基金实际 NAV 日涨跌、持仓标的行情和模型预测在数据与页面上严格区分。定期报告前十大持仓不代表完整或实时组合。

## 本地使用

需要 Node.js 20.19 或更高版本。

```bash
npm ci
npm run data:generate -- --phase=morning --date=2026-10-05
npm run data:generate -- --phase=evening --date=2026-10-05
npm run calendar:verify
npm run dev
```

可用 phase：`morning | evening | weekly | monthly | yearly | all`。省略日期时以 `Asia/Shanghai` 计算。

```bash
npm run lint
npm run typecheck
npm test
npm run data:verify
npm run backtest
npm run build
```

离线 `backtest` 只按持久化的真实特征快照顺序审计，不会用后来披露的持仓回填历史；缺少历史 feature snapshot 时会明确报告样本限制。

## GitHub Actions 调度

GitHub cron 使用 UTC，且可能延迟：

| 北京时间 | UTC cron | phase | 作用 |
|---|---|---|---|
| 工作日 10:30 | `30 2 * * 1-5` | `morning` | 抓取真实源并生成上午预测 |
| 工作日 22:30 | `30 14 * * 1-5` | `evening` | 获取最新 NAV、评估/补评；周五依次生成周报，再执行月末、年末 gate |

脚本以版本化的 SSE/SZSE 官方公告判定中国证券交易所交易日，不使用法定“调休工作日”API：周末永远休市，调休上班周末也不会生成预测。当前官方覆盖为 2025–2026；覆盖外返回 `calendar-unavailable` 并 fail closed，不存在 weekday fallback。周五无论开市或因春节、国庆等休市，晚间都会处理该日历周：没有样本为 `no-data`，存在未披露 NAV 为 `provisional`，后续每个晚间幂等重算至 `final`。周期报告只汇总，只有 evening online update 消费新增 evaluation key，因此周/月/年同日不会重复训练。

`github.event.schedule` 只标识 cron 表达式，不携带计划日期。脚本根据实际 UTC 时间反推最近一次匹配的计划时刻，再转换为上海业务日期；跨日的 evening 安全回填原目标日并记录计划/实际时间，跨日 morning 为防前视偏差明确跳过。手动运行保留 `phase` 与 `date`；只有 `workflow_dispatch` 可显式勾选 calendar override 进行覆盖外回放，默认禁用且周末仍不可覆盖。工作流使用最小权限、并发锁、原子 JSON 写入和 `[skip ci]` 数据提交。

### 交易日历维护

版本化文件为 `data/calendars/cn-exchange.json`，包含 coverage、closure reason、source、公告发布时间和 as-of。2025/2026 分别引用上交所与深交所《关于部分节假日休市安排的通知》，两所归一化结果必须完全一致。

```bash
npm run calendar:verify
npm run calendar:refresh -- \
  --year=2027 \
  --sse-url=https://www.sse.com.cn/...official.json \
  --szse-url=https://www.szse.cn/...official.json
```

只在两所发布下一年度正式公告后人工执行 refresh。命令严格校验标题、年份、公告号、日期范围及两所一致性；网络、JSON、公告格式或语义异常均非零退出，并在原子写入前保留现有文件。加 `--check` 可做受控真实源 smoke 而不写盘。`calendar:verify` 会在下一年度尚未覆盖时提前告警，但绝不生成推测日期。

## macOS 本地 Actions 调度看门狗

GitHub scheduled workflows 可能延迟或丢弃。用户级 LaunchAgent 每 5 分钟运行独立 watcher：它不在本地采集或修改基金数据，只在预期 slot 经过 15 分钟 grace 后仍未观察到 GitHub schedule run 时，调用已有 `workflow_dispatch` 并明确传入 `phase` 与上海业务 `date`。

- 交易日上午 10:30 期待 `morning`；休市日上午不 dispatch。
- 周一至周五 22:30 期待 `evening`，包括交易所休市日。周五晚始终保留，以生成 weekly close；其他晚间用于 NAV 补评及未完成周期报告。
- 每次扫描最近 3 个上海自然日，机器睡眠/关机后会 catch up；自动补偿最多 7 天，超限显式报警。
- 本地 state 记录 slot、attempt、run ID/URL、退避时间与结果。失败采用有限指数退避，不把未确认 dispatch 写成 success。
- mkdir 锁阻止并发，15 分钟后才清理 stale lock。日志和 state 不保存或打印 token。

```bash
# 安全预演，不 dispatch
npm run scheduler:once -- --dry-run --date=2026-10-08

# 可选受限回补
npm run scheduler:once -- --backfill=2026-10-06..2026-10-08

# 安装、查看状态、卸载用户级 LaunchAgent
npm run scheduler:install
npm run scheduler:status
npm run scheduler:uninstall
```

安装器将 esbuild 生成的自包含 Node runner 放到 `~/.local/share/fundoverwatch-scheduler/`，而不是依赖 Copilot worktree；plist 位于 `~/Library/LaunchAgents/com.nodegetout.fundoverwatch.scheduler.plist`，日志位于 `~/Library/Logs/FundOverwatch/`，state/lock 位于 `~/Library/Application Support/FundOverwatch/`。plist 固化安装时解析出的 `node` 与 `gh` 绝对路径；鉴权继续使用用户现有 `gh auth`，不会复制 token。

这不是绝对可用性保证：Mac 必须定期开机、联网且 `gh` 登录有效。7 天以上离线不会自动制造大量历史 dispatch；GitHub API/Actions 整体故障时 watcher 会持续有限重试并保留 pending/failed 状态。真正高可用需要第二个独立设备或云 scheduler 作为外部调度源。

## 数据源与时效

- NAV：天天基金/东方财富 F10 历史净值接口，`FSRQ` 为净值日期，`DWJZ` 为单位净值。
- 持仓：最新公开定期报告；股票、债券、基金、目标 ETF 按源字段规范化。报告期、采集时间和行情时间分别保存。
- 标的行情：东方财富公开行情接口。只有源提供可靠市场标识且时间不晚于上午特征截止时才进入预测。

公开接口没有 SLA，NAV 常在当晚或下一工作日披露，QDII 延迟可能更长。采集失败会显式失败并保留上次成功数据；不会返回 success-shaped fallback。所有内容仅用于实验性软件与信息展示，可能延迟或不完整，**不构成投资建议**。

详细契约和路径见 [数据架构](docs/data-architecture.md)，模型规则见 [预测模型说明](docs/prediction-roadmap.md)。
