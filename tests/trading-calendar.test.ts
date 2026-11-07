import { describe, expect, it, vi } from "vitest";
import {
  fetchJson,
  textFromHtml,
  weekdayClosures
} from "../scripts/trading-calendar";

const notice = `
  <p>（一）元旦：1月1日（星期四）至1月3日（星期六）休市，1月5日起照常开市。</p>
  <p>（二）春节：2月15日（星期日）至2月23日（星期一）休市。</p>
  <p>（三）清明节：4月4日（星期六）至4月6日（星期一）休市。</p>
  <p>（四）劳动节：5月1日（星期五）至5月5日（星期二）休市。</p>
  <p>（五）端午节：6月19日（星期五）至6月21日（星期日）休市。</p>
  <p>（六）中秋节：9月25日（星期五）至9月27日（星期日）休市。</p>
  <p>（七）国庆节：10月1日（星期四）至10月7日（星期三）休市。</p>
`;

describe("trading calendar maintenance", () => {
  it("normalizes official ranges while excluding weekend adjustment days", () => {
    const text = textFromHtml(notice);
    const closures = weekdayClosures(text, 2026);
    expect(closures).toContainEqual({ date: "2026-02-23", reason: "春节" });
    expect(closures).not.toContainEqual(expect.objectContaining({ date: "2026-02-21" }));
    expect(closures).not.toContainEqual(expect.objectContaining({ date: "2026-02-22" }));
  });

  it("uses mocked network responses and fails explicitly on HTTP errors", async () => {
    const success = vi.fn<typeof fetch>(async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await expect(fetchJson("https://official.example/calendar.json", success)).resolves.toEqual({
      raw: '{"ok":true}',
      value: { ok: true }
    });
    const failure = vi.fn<typeof fetch>(async () => new Response("down", { status: 503 }));
    await expect(fetchJson("https://official.example/calendar.json", failure)).rejects.toThrow(
      "HTTP 503"
    );
  });
});
