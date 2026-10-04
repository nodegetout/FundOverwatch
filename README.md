# Fund Overwatch

Fund Overwatch 是基于 Astro + TypeScript 的多市场基金跟踪与分析静态网站。中国大陆基金使用公开日终单位净值，其他市场使用**明确标注的确定性模拟数据**；页面和数据契约会逐基金展示来源、真实/模拟模式、质量与数据日期。数据采集不需要密钥，也不提供前端伪密码。

## 功能

- “中文名称-代号”市场标签与可访问、可键盘操作的市场 Tab
- 中国大陆 8 只指定公募基金的真实历史单位净值
- 美国、中国香港、日本示例基金的确定性模拟数据
- 净值/价格、日/周/月/年收益、年化波动率、最大回撤、20/60 日均线与基准超额收益
- 主要持仓、行业及国家/地域暴露
- 数据质量、最近更新时间、盘中/最终状态、空状态和异常说明
- 按基金和年份分区的 JSON 历史数据，幂等运行键与周期汇总
- 响应式 Astro 静态站，可部署至 GitHub Pages

## 本地开发

需要 Node.js 20.19 或更高版本。

```bash
npm ci
npm run data:generate -- --date=2026-10-02 --mode=final
npm run dev
```

常用验证命令：

```bash
npm run lint
npm run typecheck
npm test
npm run data:verify
npm run build
```

## 数据更新

基金清单维护在 [`data/funds.json`](data/funds.json)。`providerRef` 由流水线路由：`eastmoney:<code>` 使用真实单位净值适配器，`mock:<id>` 使用确定性模拟适配器。不要把供应商逻辑写入分析或页面层。

```bash
# 参数省略时，日期由 Asia/Shanghai 决定
npm run data:generate -- --mode=intraday
npm run data:generate -- --mode=final
```

同一 `date + mode + provider version` 只执行一次。全部基金采集与校验成功后才写文件；网络失败、空数据、响应异常或基金代码不匹配会让任务显式失败，GitHub Actions 不会提交部分输出。当前工作日规则仅排除周末，真实市场节假日历已明确留作后续适配。详细结构和数据源约束见 [数据架构](docs/data-architecture.md)。

## 自动化

- 北京时间 11:00（UTC 03:00）：刷新数据；CN 仍为最近已公布日终净值并标记 as-of/stale，绝不冒充盘中估值
- 北京时间 21:00（UTC 13:00）：生成最终数据和日汇总
- 最终任务在北京时间周/月/年边界生成对应汇总
- 工作流支持手动日期与模式、并发锁、最小权限、验证失败不提交、无变更不提交
- 数据提交只触发专用流程中的 Pages 部署，常规部署任务排除机器人提交，避免循环

GitHub Actions 的 cron 可能延迟，因此日期、工作日和边界均由脚本按 `Asia/Shanghai` 计算，而不是依赖任务实际启动分钟。

## 部署和访问控制

管理员设置步骤、套餐前提、Cloudflare DNS/代理/HTTPS、默认 `github.io` 旁路风险、Secrets 限制和回滚流程见 [私有部署指南](docs/private-pages-cloudflare.md)。仓库不会生成占位 `CNAME`，以免误绑定域名。

## 数据来源与声明

中国大陆单位净值来自天天基金/东方财富公开 F10 接口，字段 `FSRQ` 表示净值日期、`DWJZ` 表示单位净值。该接口无 SLA，可能延迟、调整或暂停；本项目设置超时、有限重试和严格校验，但不保证持续可用。其他市场数据是确定性模拟数据。所有内容仅用于软件演示和信息展示，可能延迟或不完整，**不构成投资建议**。
