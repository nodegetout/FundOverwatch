# GitHub Pages 部署指南

当前方案是公开 GitHub 仓库加公开 GitHub Pages。仓库中的源代码、Git 历史、Actions
日志与 artifacts，以及 Pages 发布的基金数据和静态资源，都应按公开信息处理，不能包含
凭据、个人敏感信息或其他受限内容。

## GitHub 设置

1. 在 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**。
2. 在 Actions variables 添加：
   - `SITE_URL=https://nodegetout.github.io`
   - `BASE_PATH=/FundOverwatch`
3. 不设置自定义域名，也不提交 `CNAME`。
4. 在 **Actions → General** 保留默认只读权限。数据工作流仅对 `refresh` job 临时授予
   `contents: write`；Pages deploy job 仅获 `pages: write` 和 `id-token: write`。
5. 若分支保护禁止 GitHub Actions 直接推送，创建仅允许数据路径更新的受控规则或改为由
   机器人创建 PR，不要放宽所有分支保护。

本项目不需要行情密钥。GitHub Pages 构建产生的文件是公开可下载的静态资产，因此即使使用 Actions Secrets，也绝不能把任何秘密写入 `PUBLIC_*`、HTML、JavaScript 或 `public/data`。

## 发布验证

- 手动运行 `Deploy Pages`，检查构建和 deployment environment
- 匿名访问 `https://nodegetout.github.io/FundOverwatch/` 并确认首页与静态数据返回 200
- 检查页面显示“模拟数据”“非投资建议”和最新北京时间
- 确认仓库、Actions artifact、Pages 静态文件均不含秘密

## 可选的 Cloudflare Access 迁移

未来若改用自定义域名，可在 Cloudflare 托管 DNS、启用代理与 **Full (strict)** TLS，并为
自定义域名配置 Zero Trust Access。该方案只能保护经过 Cloudflare 的自定义域名，不能保护
或隐藏 `https://nodegetout.github.io/FundOverwatch/`，也不会改变仓库和已发布数据的公开
属性。若访问控制是硬性要求，应改用能够关闭公开源站的托管方案，而不是把 GitHub Pages
继续作为可访问的源站。

## 回滚

1. 在 GitHub 将默认分支回退到已验证提交，再手动运行 `Deploy Pages`；不要删除历史数据来掩盖错误。
2. 若发布内容存在凭据或受限信息，立即禁用 Pages，并按凭据轮换和 Git 历史清理流程处理。
3. 若部署配置异常，恢复 `SITE_URL` 和 `BASE_PATH` 后重新运行工作流，不要提交临时
   `CNAME` 或改用不受控域名。
