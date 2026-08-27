# GitHub Actions 配置说明

本文档说明如何配置 GitHub Actions 实现 Trae 每日自动签到（北京时间每天 05:00）。

## 原理

Trae 凭证存储在本地 `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`。
GitHub Actions 运行在云端，需将本地凭证文件 Base64 编码后作为 Secret 传入，
运行时解码回原文件供脚本解密使用。

## 配置步骤

### 1. 导出本地凭证（Base64）

**PowerShell（推荐，自动复制到剪贴板）：**

```powershell
$bytes = [IO.File]::ReadAllBytes("$env:APPDATA\TRAE SOLO CN\User\globalStorage\storage.json")
Set-Clipboard ([Convert]::ToBase64String($bytes))
Write-Host "已复制到剪贴板"
```

**CMD：**

```cmd
certutil -encode "%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json" storage.b64
type storage.b64
```

### 2. 添加 GitHub Secret

1. 进入你的仓库 → **Settings** → **Secrets and variables** → **Actions**
2. 点击 **New repository secret**
3. Name 填：`TRAE_CREDENTIALS_BASE64`
4. Value 粘贴上一步的 Base64 字符串
5. 点击 **Add secret**

### 3. 手动测试

进入 **Actions** → **Trae 每日签到** → **Run workflow** 手动触发一次，
确认输出中有 `[RESULT] {...}` 且 `error` 为 `null`。

### 4. 自动执行

配置完成后无需再管。工作流每天 **北京时间 05:00** 自动执行，附带随机延迟避免集中请求。

## 保活机制

GitHub 会禁用 60 天无提交记录仓库的定时工作流。本仓库内置
`keepalive.yml`，每周自动提交一次 `.keepalive` 时间戳文件保活，无需手动干预。

## 注意事项

- **凭证过期**：Trae Token 有效期约 14 天。云端刷新依赖服务端设备公钥匹配，
  若出现 `REFRESH_FAIL` 或 `NO_SESSION`，请在本地重新登录 Trae 并重新导出凭证更新 Secret
- **安全**：Base64 只是编码不是加密，Secret 仅对有仓库写权限的人可见，请勿分享
- **多账户**：暂不支持多账户，如需可 Fork 多个仓库分别配置

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| `NO_STORAGE` | 确认 `TRAE_CREDENTIALS_BASE64` Secret 已正确设置 |
| `NO_AUTH` | 重新登录 Trae 客户端后重新导出 |
| `NO_SESSION` / 401/403 | 登录态过期，重新导出凭证并更新 Secret |
| Actions 未按时执行 | 检查 Actions 是否被手动/自动禁用；检查保活是否生效 |
