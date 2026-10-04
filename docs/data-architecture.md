# 数据架构

## 契约与适配层

`src/lib/domain.ts` 使用 Zod 定义并运行时校验以下统一模型：

- `Fund`：市场、交易所、币种、资产类别、基准、时区、成立日期及供应商引用
- `Quote`：日期、净值、价格、基准价格、币种及质量信息
- `HoldingsSnapshot`：持仓、行业及国家/地域权重
- `DataQuality`：完整度、来源、模拟标识、采集时间、警告及缺失字段
- `FundAnalytics` 和前端 `SiteIndex`

`FundDataProvider` 是唯一的数据采集边界。`DeterministicMockProvider` 产生与日期、基金和版本相关的稳定数据。后续供应商适配器必须在边界内完成原始字段映射、异常显式抛出和质量标记；不得以空数据伪装成功。

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

盘中和最终运行共享单日记录；最终运行会以最终值替换当日盘中值。模拟供应商的最终数据不含盘中扰动。质量字段会贯穿原始快照和页面索引。

## 分析规则

- 基准日期使用“目标边界当日或之前的最近观测”，覆盖周末和缺失日期
- 零基值、空值、非有限数不参与收益计算，返回 `null`
- 年化波动率使用有效日收益样本标准差并乘以 `sqrt(252)`
- 最大回撤使用运行峰值计算
- 20/60 日均线在有效观测不足时返回 `null`
- 年收益及基准收益使用 365 日边界最近值，超额收益为两者之差

当前工作日适配器只识别周一至周五。接入真实数据前应增加按市场区分的交易日历接口，并为半日市、临时休市和时区切换添加测试。

## 周期边界

最终模式才写周期汇总。周边界为周五；月/年边界由下一个工作日是否进入新月/新年判断。任务即使延迟启动，也使用 Asia/Shanghai 日期计算。每个周期键写入时替换已有记录，保持幂等。
