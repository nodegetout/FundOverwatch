# 私有 GitHub Pages + Cloudflare Access 部署指南

以下步骤需要仓库管理员在 GitHub 和 Cloudflare 控制台完成。文中的 `<CUSTOM_DOMAIN>`、`<GITHUB_ORG>` 和 `<REPOSITORY>` 都是占位符，提交前不要替换成不受控域名。仓库刻意不包含 `CNAME` 文件，避免错误域名被 Pages 接管。

## 前提和套餐

1. 确认当前 GitHub 组织/企业套餐支持从**私有仓库**发布 Pages。能力和可见性选项会随 GitHub 套餐变化；若设置页没有对应选项，不要把仓库改为公开作为替代方案。
2. 域名 DNS 必须由 Cloudflare 托管，并使用支持 Access 的 Cloudflare Zero Trust 套餐。核对用户数量、身份提供商和策略保留期是否满足组织要求。
3. GitHub Pages 本身不是本方案的身份边界。Cloudflare Access 仅能保护经过 Cloudflare 代理的自定义域名。

## GitHub 设置

1. 在 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**。
2. 在 Actions variables 添加：
   - `SITE_URL=https://<CUSTOM_DOMAIN>`
   - `BASE_PATH=/`（自定义根域名）；若仅测试项目 Pages，则用 `/<REPOSITORY>`
3. 在 Pages 自定义域名中填写 `<CUSTOM_DOMAIN>`，等待 DNS 检查通过后启用 **Enforce HTTPS**。
4. 在 **Actions → General** 保留默认只读权限。数据工作流仅对 `refresh` job 临时授予 `contents: write`；Pages deploy job 仅获 `pages: write` 和 `id-token: write`。
5. 若分支保护禁止 GitHub Actions 直接推送，创建仅允许数据路径更新的受控规则或改为由机器人创建 PR。不要放宽所有分支保护。

本项目不需要行情密钥。GitHub Pages 构建产生的文件是公开可下载的静态资产，因此即使使用 Actions Secrets，也绝不能把任何秘密写入 `PUBLIC_*`、HTML、JavaScript 或 `public/data`。

## Cloudflare DNS、代理和 HTTPS

1. 按 GitHub Pages 的当前说明为 `<CUSTOM_DOMAIN>` 创建 CNAME 或 apex 记录，目标使用仓库 Pages 提供的主机名。
2. DNS 记录启用 Cloudflare **Proxied（橙云）**。灰云会绕过 Access。
3. 在 **SSL/TLS** 使用 **Full (strict)**。待 GitHub Pages 证书签发并开启 Enforce HTTPS 后再强制此模式；不要长期使用 Flexible。
4. 开启 **Always Use HTTPS**，并检查重定向没有形成循环。
5. 在 Cloudflare Zero Trust 创建 Self-hosted Application，域名设为 `<CUSTOM_DOMAIN>`，Access policy 采用明确的允许列表（组织邮箱域、身份组或设备姿态），最后添加默认拒绝策略。
6. 设置较短会话期，验证登录、退出、过期和未授权身份均符合预期。

## `github.io` 旁路风险

Cloudflare Access 无法拦截 `https://<ACCOUNT>.github.io/<REPOSITORY>/`。即使私有仓库 Pages 在当前套餐下受 GitHub 身份限制，也必须把默认 Pages 地址视为潜在旁路并实测：

1. 使用未登录 GitHub、未登录 Cloudflare 的无痕窗口分别访问自定义域名和默认 `github.io` 地址。
2. 自定义域名必须进入 Access；默认地址必须被 GitHub 拒绝或不可用。
3. 从不同网络再次验证 DNS 记录均经过 Cloudflare。
4. 每次修改仓库可见性、Pages 可见性或自定义域名后重复验证。

若组织要求“任何情况下都不能存在 GitHub 默认域名”，GitHub Pages 不适合作为源站，应改用可验证源站访问控制的 Cloudflare Pages、Workers 或私有对象存储。

## 发布验证

- 手动运行 `Deploy Pages`，检查构建和 deployment environment
- 手动运行两种 `Refresh fund data` 模式，确认重复运行无提交
- 检查页面显示“模拟数据”“非投资建议”和最新北京时间
- 检查 TLS 证书、HSTS 策略、Access 审计日志和所有身份策略
- 确认仓库、Actions artifact、Pages 静态文件均不含秘密

## 回滚

1. 在 GitHub 将默认分支回退到已验证提交，再手动运行 `Deploy Pages`；不要删除历史数据来掩盖错误。
2. 若 Access 策略错误，先恢复上一版策略或启用仅管理员可用的应急策略，不要把 DNS 改为灰云。
3. 若证书或域名绑定异常，移除 Pages 自定义域名并等待 GitHub 释放绑定，再按官方流程重新添加。不要提交临时占位 `CNAME`。
4. 严重事件中可禁用 Pages 或暂停 Cloudflare 应用。恢复前重新执行 `github.io` 旁路、TLS 和未授权访问测试。
