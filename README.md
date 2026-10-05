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
| 工作日 22:30 | `30 14 * * 1-5` | `evening` | 获取最新 NAV、评估/补评、月末/年末 gate |
| 周六 10:30 | `30 2 * * 6` | `weekly` | 复盘上一完整交易周 |

脚本内部使用上海日期、工作日校验、明确维护的 2026 中国内地交易所休市日和 `date + phase + pipeline version` 幂等键。普通周一至周五不等同于必然开市：休市日上午不创建预测；日历覆盖范围外再以源交易日期防误判并明确使用 weekday fallback。月末/年末若落在周末，最后一个工作日晚先生成 `provisional`；后续晚间在最终 NAV 可用后可补全。`12-31` 生成年度 provisional/final，年度已评估样本进入后续有界校准。

手动运行支持 `phase` 与 `date`。工作流使用最小权限、并发锁、无变化不提交、原子 JSON 写入和 `[skip ci]` 数据提交；数据任务自身部署 Pages，普通 Pages workflow 排除机器人提交，避免循环。

## 数据源与时效

- NAV：天天基金/东方财富 F10 历史净值接口，`FSRQ` 为净值日期，`DWJZ` 为单位净值。
- 持仓：最新公开定期报告；股票、债券、基金、目标 ETF 按源字段规范化。报告期、采集时间和行情时间分别保存。
- 标的行情：东方财富公开行情接口。只有源提供可靠市场标识且时间不晚于上午特征截止时才进入预测。

公开接口没有 SLA，NAV 常在当晚或下一工作日披露，QDII 延迟可能更长。采集失败会显式失败并保留上次成功数据；不会返回 success-shaped fallback。所有内容仅用于实验性软件与信息展示，可能延迟或不完整，**不构成投资建议**。

详细契约和路径见 [数据架构](docs/data-architecture.md)，模型规则见 [预测模型说明](docs/prediction-roadmap.md)。
