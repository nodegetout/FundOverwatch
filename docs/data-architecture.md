# 数据架构

## 契约与适配层

`src/lib/domain.ts` 使用 Zod 定义并运行时校验以下统一模型：

- `Fund`：市场、交易所、币种、资产类别、基准、时区、成立日期及供应商引用
- `Quote`：日期、净值、价格、基准价格、币种及质量信息
- `HoldingsSnapshot`：持仓、行业及国家/地域权重
- `DataQuality`：完整度、来源、`real/simulated` 模式、采集时间、警告及缺失字段
- `FundAnalytics` 和前端 `SiteIndex`

`FundDataProvider` 是唯一的数据采集边界。流水线按 `providerRef` 路由：

- `eastmoney:<code>` → `EastmoneyNavProvider`：中国大陆公募基金真实日终单位净值
- `mock:<id>` → `DeterministicMockProvider`：其他市场确定性模拟行情及说明性持仓

适配器在边界内完成字段映射、异常显式抛出和质量标记；不得以空数据或模拟数据伪装真实采集成功。流水线先在内存中完成所有基金的采集、Schema 校验、合并与分析，任何一只失败都在写盘前终止，从而保留仓库上次成功数据。

## 中国大陆真实数据源

使用天天基金/东方财富公开 F10 接口，无需 API key：

- 元数据：`FundMNDetailInformation`，以返回的 `FCODE` 校验请求基金代码
- 历史净值：`f10/lsjz`，`FSRQ` 为净值日期，`DWJZ` 为单位净值

每次保留最近最多 260 个源观测，足够页面的一年期窗口，同时控制仓库体积。请求使用明确 User-Agent、12 秒 timeout 和最多 2 次重试。空列表、错误码、Schema 异常、无效净值、分页缺失或代码不匹配都会失败，不生成 success-shaped fallback。

公开源仅提供日终净值语义。即使 11:00 执行 `intraday` 任务，CN Quote 的 `valuation` 仍为 `final`，日期仍为最近公布的 `FSRQ`；落后于任务日期时质量为 `stale`。源未提供本项目可规范化的交易价格、基准序列和持仓快照，因此这些字段显式为空并列入 `missingFields`。

该公开接口没有 SLA，字段、访问策略和更新时点可能变化；使用应保持低频并遵守来源站点适用条款。数据可能延迟或不完整，仅供信息展示，不构成投资建议。

## 存储布局

主格式为 JSON：

```text
data/
  funds.json
  runs.json
  history/<fund-id>/<year>.json
  history/<fund-id>/years.json
  holdings/<fund-id>/<date>.json
  summaries/{weekly,monthly,yearly}/<fund-id>.json
public/data/
  index.json
  series/<fund-id>.json
```

历史记录按基金与年份分区。写入前按日期去重并排序，序列化内容未变化时不写文件。`runs.json` 用 `date:mode:provider-version` 作为幂等键。`public/data/index.json` 是页面使用的小型最新汇总；每个 `series` 文件只保留最近 260 个观测值。

盘中和最终运行共享单日记录；最终运行会以最终值替换当日盘中值，但合并规则禁止 intraday 覆盖已有 final。模拟供应商的最终数据不含盘中扰动。真实 CN 只写源日期对应的 final 单位净值。质量字段会贯穿原始快照和页面索引。

## 分析规则

- 基准日期使用“目标边界当日或之前的最近观测”，覆盖周末和缺失日期
- 零基值、空值、非有限数不参与收益计算，返回 `null`
- 年化波动率使用有效日收益样本标准差并乘以 `sqrt(252)`
- 最大回撤使用运行峰值计算
- 20/60 日均线在有效观测不足时返回 `null`
- 年收益及基准收益使用 365 日边界最近值，超额收益为两者之差

当前任务调度日历只识别周一至周五；真实 CN 的数据日期以来源发布日为准，因此节假日运行只会安全保留最近公布值并标记 stale。后续仍应增加按市场区分的交易日历接口，并为半日市、临时休市和时区切换添加测试。

## 周期边界

最终模式才写周期汇总。周边界为周五；月/年边界由下一个工作日是否进入新月/新年判断。任务即使延迟启动，也使用 Asia/Shanghai 日期计算。每个周期键写入时替换已有记录，保持幂等。
