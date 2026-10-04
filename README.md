# Fund Overwatch

Fund Overwatch 是基于 Astro + TypeScript 的多市场基金跟踪与分析静态网站。首期使用**明确标注的确定性模拟数据**，不连接真实行情 API、不需要密钥，也不提供前端伪密码。访问控制由私有仓库、GitHub Pages 自定义域名和 Cloudflare Access 共同承担。

## 功能

- US、HK、CN、JP 多市场示例基金与统一元数据
- 净值/价格、日/周/月/年收益、年化波动率、最大回撤、20/60 日均线与基准超额收益
- 主要持仓、行业及国家/地域暴露
- 数据质量、最近更新时间、盘中/最终状态、空状态和异常说明
- 按基金和年份分区的 JSON 历史数据，幂等运行键与周期汇总
- 响应式 Astro 静态站，可部署至 GitHub Pages

## 本地开发

需要 Node.js 20.11 或更高版本。

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

基金清单维护在 [`data/funds.json`](data/funds.json)。新增基金时需同时在 `DeterministicMockProvider` 中添加模拟配置；未来真实数据源应实现 `FundDataProvider`，不要把供应商逻辑写入分析或页面层。

```bash
# 参数省略时，日期由 Asia/Shanghai 决定
npm run data:generate -- --mode=intraday
npm run data:generate -- --mode=final
```

同一 `date + mode + provider version` 只执行一次。当前工作日规则仅排除周末，真实市场节假日历已明确留作后续适配。详细结构见 [数据架构](docs/data-architecture.md)。

## 自动化

- 北京时间 11:00（UTC 03:00）：生成盘中数据
- 北京时间 21:00（UTC 13:00）：生成最终数据和日汇总
- 最终任务在北京时间周/月/年边界生成对应汇总
- 工作流支持手动日期与模式、并发锁、最小权限、验证失败不提交、无变更不提交
- 数据提交只触发专用流程中的 Pages 部署，常规部署任务排除机器人提交，避免循环

GitHub Actions 的 cron 可能延迟，因此日期、工作日和边界均由脚本按 `Asia/Shanghai` 计算，而不是依赖任务实际启动分钟。

## 部署和访问控制

管理员设置步骤、套餐前提、Cloudflare DNS/代理/HTTPS、默认 `github.io` 旁路风险、Secrets 限制和回滚流程见 [私有部署指南](docs/private-pages-cloudflare.md)。仓库不会生成占位 `CNAME`，以免误绑定域名。

## 重要声明

所有数据均为模拟数据，仅用于软件演示和流程验证，**不构成投资建议**。
