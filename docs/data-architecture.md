# 数据架构

## 生产边界

`FundDataProvider` 保留采集抽象，但生产只路由 `eastmoney:<code>` 到 `EastmoneyNavProvider`。全仓生产数据仅包含 `data/funds.json` 中 8 只 `CN` 基金。网络失败、空 NAV、代码不匹配、空持仓或 Schema 错误会终止本次运行；写盘前的数据先在内存校验，JSON 使用同目录临时文件再原子 rename。测试可以注入内存 `fetch` 响应，但不存在生产 fallback。

核心 Zod 契约：

- `Fund`、`Quote`、`HoldingsSnapshot`、`HoldingQuoteBatch`：基金、真实 NAV、定期报告持仓、标的行情。
- `FundPrediction`：目标交易日、预测收益/方向、置信度、特征时间、报告期、覆盖率、模型版本、质量和贡献项。
- `PredictionEvaluation`：`pending/evaluated/unavailable`、实际 NAV 区间、误差与方向命中；`evaluationKey` 与 prediction 一一对应。
- `ModelArtifact`：有界 bias/scale、样本数、训练截止日和已应用 evaluation keys。
- `PeriodReport`：周/月/年总体与分组指标、缺失率、最佳/最差案例及模型变化。
- `TradingCalendar`：SSE/SZSE 官方来源、as-of、覆盖区间、交易所休市日期与原因；周末闭市由算法表达。

## 时间与无前视约束

上午 feature timestamp 固定为目标上海日期 `10:30+08:00`。持仓行情 `asOf` 晚于该时间的一律排除；NAV 动量只使用 `quote.date < predictionDate` 的已披露值。模型参数只接受预测产生后已对齐的 `evaluated` 样本，每个 evaluation key 最多训练一次。

预测目标为“基金下一可对齐 NAV 的日涨跌幅/方向”。当前日目标 NAV 未披露时，晚间结果是 `pending` 而不是当日最终值；后续运行用目标交易日 NAV 和之前最近一个 NAV 计算实际收益。

交易日只依据版本化的 SSE/SZSE 交易所公告，不依据国务院调休工作日：周六、周日始终闭市；工作日节假日和临时休市由日历记录。当前覆盖 2025–2026，2027 尚无已提交官方公告。覆盖外为 `calendar-unavailable`，来源冲突为 `source-error`，两者都 fail closed，不创建预测或训练样本。手动回放可显式 override 覆盖缺失年份，但默认关闭且不能把周末改为交易日。

GitHub schedule 事件只有 cron 字符串，没有计划日期。`resolveScheduledRun` 从实际 UTC 时刻反推最近一次匹配的 cron，转换为 `Asia/Shanghai` 业务日期，并同时持久化 `scheduledAt` / `actualRunAt`。晚间跨日延迟可安全回填原目标日期；上午跨日会跳过，避免以后见数据生成过去预测。

## 存储布局

```text
data/
  funds.json
  runs.json
  calendars/cn-exchange.json
  history/<fund-id>/<year>.json
  holdings/<fund-id>/<report-date>.json
  holding-quotes/<fund-id>/<collection-date>.json
  predictions/
    years.json
    <year>/predictions.json
  evaluations/
    years.json
    <year>/evaluations.json
  reports/{weekly,monthly,yearly}/<period-key>.json
  models/cn-baseline-v1.json
public/data/
  index.json
  series/<fund-id>.json
```

历史、预测和评估按年分区；public 只保存页面需要的最近汇总和最多 260 个 NAV 点，不复制完整行情。数组按稳定 key 排序，同一 key 替换而不追加重复记录。`runs.json` 使用 `<date>:<phase>:cn-loop-v2` 幂等替换同一业务运行记录，并保存计划/实际时刻、日历状态和跳过原因。流水线允许同一 evening 日期再次采集，以便补齐延迟 NAV；prediction/evaluation/report 仍按稳定 key 替换，模型以 `appliedEvaluationKeys` 保证每个样本只消费一次。

## 周期关闭

- 周报：每个日历周五 evening 在当晚评估之后生成；周五休市仍统计周一至周五范围内的实际样本。
- 月报/年报：报告期最后实际交易日晚生成；日历期末尚未到达或 NAV 未齐时为 provisional。
- 同日顺序固定为 evaluation → weekly → monthly → yearly。周期报告只汇总和审计，不更新模型；online calibration 只在 evening 消费新增 evaluation key。
- `provisional` 报告在后续每个 evening 以同一 report key 重算；齐全后成为 `final`。报告期无预测/评估样本时为 `no-data`，不拿上期数据填充或训练。

指标包括日历范围、最后实际交易日、交易日数、缺失 NAV 数、样本数、方向准确率、MAE、RMSE、平均误差，以及按基金、confidence bin、coverage bin 分组结果。每份报告记录交易日历来源与 as-of。
