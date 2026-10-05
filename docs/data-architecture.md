# 数据架构

## 生产边界

`FundDataProvider` 保留采集抽象，但生产只路由 `eastmoney:<code>` 到 `EastmoneyNavProvider`。全仓生产数据仅包含 `data/funds.json` 中 8 只 `CN` 基金。网络失败、空 NAV、代码不匹配、空持仓或 Schema 错误会终止本次运行；写盘前的数据先在内存校验，JSON 使用同目录临时文件再原子 rename。测试可以注入内存 `fetch` 响应，但不存在生产 fallback。

核心 Zod 契约：

- `Fund`、`Quote`、`HoldingsSnapshot`、`HoldingQuoteBatch`：基金、真实 NAV、定期报告持仓、标的行情。
- `FundPrediction`：目标交易日、预测收益/方向、置信度、特征时间、报告期、覆盖率、模型版本、质量和贡献项。
- `PredictionEvaluation`：`pending/evaluated/unavailable`、实际 NAV 区间、误差与方向命中；`evaluationKey` 与 prediction 一一对应。
- `ModelArtifact`：有界 bias/scale、样本数、训练截止日和已应用 evaluation keys。
- `PeriodReport`：周/月/年总体与分组指标、缺失率、最佳/最差案例及模型变化。

## 时间与无前视约束

上午 feature timestamp 固定为目标上海日期 `10:30+08:00`。持仓行情 `asOf` 晚于该时间的一律排除；NAV 动量只使用 `quote.date < predictionDate` 的已披露值。模型参数只接受预测产生后已对齐的 `evaluated` 样本，每个 evaluation key 最多训练一次。

预测目标为“基金下一可对齐 NAV 的日涨跌幅/方向”。当前日目标 NAV 未披露时，晚间结果是 `pending` 而不是当日最终值；后续运行用目标交易日 NAV 和之前最近一个 NAV 计算实际收益。

交易日规则分两层：

1. 调度层排除周末，并维护 2026 中国内地交易所明确休市日；通过月末/年末最后工作日生成 provisional gate。
2. 数据层以公开源返回的交易日期/NAV 日期为准；法定节假日无新日期时不认为当日已开市。

日历覆盖范围外尚未接入权威动态交易日服务，这是明确限制；这类日期使用 weekday fallback，但仍以源行情/NAV 日期防误判，不把“周一至周五”等同于真实开市。

## 存储布局

```text
data/
  funds.json
  runs.json
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

历史、预测和评估按年分区；public 只保存页面需要的最近汇总和最多 260 个 NAV 点，不复制完整行情。数组按稳定 key 排序，同一 key 替换而不追加重复记录。`runs.json` 使用 `<date>:<phase>:cn-loop-v1`。

## 周期关闭

- 周报：周六处理上一完整周一至周五。
- 月报：日历月末工作日生成 final；月末为周末时最后工作日生成 provisional。
- 年报：12 月最后工作日生成 provisional/final；已评估年度样本参与之后校准。
- NAV 延迟导致 report 中存在 pending 时状态保持 provisional；后续 gate/补全运行以同一 report key 覆盖，不重复写。

指标包括样本数、方向准确率、MAE、RMSE、平均误差、缺失率，以及按基金、confidence bin、coverage bin 分组结果。
