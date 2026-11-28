# 预测模型说明

## `cn-baseline-v1`

这是确定性、可解释、版本化的实验基线，不使用“AI”营销或黑箱模型。目标是预测基金下一可对齐 NAV 的日收益率和 `up/down/flat` 方向，不是预测持仓股票价格。

基础信号：

1. 已披露持仓权重 × 上午截止前可获得的股票/ETF 日涨跌；先在可报价持仓内归一，再按实际覆盖率折扣。
2. 预测日前已经披露的最近 NAV 动量与波动。
3. 仅由历史已评估样本更新的 online bias 和 scale。

预测收益有界在 ±10%，bias 有界在 ±3%，scale 有界在 `[0.5, 1.5]`。少于 10 个新样本不更新 bias，少于 20 个累计样本不更新 scale；年度/长期影响通过 evaluation 样本和有界、缓慢更新体现，不把全年准确率硬编码进下一次预测。

置信度由行情覆盖率、样本量、数据新鲜度和波动共同决定，最高限制为 85%。QDII、债券、场外资产、未提供市场标识、陈旧或低覆盖行情均降低置信度并写入 warnings。披露持仓不完整时不会把前十大等同完整组合。

## 评估和校准

晚间按 `fundId + targetTradeDate` 对齐 prediction 与 NAV：

- 目标 NAV 不存在：`pending`，保留原因，之后自动补评。
- 可对齐：记录 actual return、error、absolute error、squared error、direction correct 和 confidence bin。
- `appliedEvaluationKeys` 防止重复运行重复训练同一样本。

周/月/年报告只统计当期目标日期内已经评估的样本，并单独计算 missing rate。模型 artifact 保存版本、样本数、训练截止日期、bias、scale、MAE/RMSE 和方向准确率。

模型校准只有一个入口：晚间补评完成后的 online update。周、月、年报告是只读汇总/审计，即使多个周期在同一天关闭，也按周→月→年生成且不会再次消费 evaluation。`no-data` 周期不复制上一期样本，`provisional` 周期在 NAV 补齐后用稳定 report key 替换。

## 回测限制

`npm run backtest` 是严格时间顺序的持久化快照审计。项目不会用今天看到的持仓报告和行情倒推过去的“预测”，因此当前历史 feature snapshot 少时，回测会诚实报告样本不足。长期积累真实上午快照后才能讨论稳健性。

所有结果仅用于实验性估测和软件验证，**不构成投资建议**。
