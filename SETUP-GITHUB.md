# GitHub Actions 配置说明

本文档说明如何配置 GitHub Actions 实现 Trae 每日自动签到（北京时间每天 06:00），支持**单人单账号**与**多人多账号**自动签到。

## 原理

Trae 凭证存储在本地，具体路径取决于你安装的是哪个产品：

| 产品 | 本地路径 |
|---|---|
| **Trae CN**（新版 IDE，3.x） | `%APPDATA%\Trae CN\User\globalStorage\storage.json` |
| **TRAE SOLO CN**（SOLO 客户端） | `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` |

本地运行时脚本会自动选取两个文件中**修改时间较新**的那个；手动导出 Secret 时请确认选的是你最近登录过的产品，否则会导出过期凭据并报 `NO_SESSION`。

GitHub Actions 运行在云端，将本地凭证 Base64 编码后作为 Secret 传入，脚本会自动解密并调用官方接口完成签到。

---

## 快速配置步骤

### 1. 导出本地凭证（Base64）

在安装并登录了 Trae 的电脑上打开终端执行。

**PowerShell — 自动挑选最新的那个（推荐）：**

```powershell
$file = @("$env:APPDATA\Trae CN", "$env:APPDATA\TRAE SOLO CN") |
    ForEach-Object { Join-Path $_ 'User\globalStorage\storage.json' } |
    Where-Object { Test-Path $_ } |
    Sort-Object { (Get-Item $_).LastWriteTime } -Descending |
    Select-Object -First 1
if (-not $file) { throw "未找到 storage.json，请先登录 Trae 客户端" }
$bytes = [IO.File]::ReadAllBytes($file)
Set-Clipboard ([Convert]::ToBase64String($bytes))
Write-Host "已复制到剪贴板：$file（$($bytes.Length) 字节）"
```

**PowerShell — 指定产品（二选一）：**

```powershell
# Trae CN（新版 IDE）
$bytes = [IO.File]::ReadAllBytes("$env:APPDATA\Trae CN\User\globalStorage\storage.json")
Set-Clipboard ([Convert]::ToBase64String($bytes))
Write-Host "已复制到剪贴板"
```

```powershell
# TRAE SOLO CN（SOLO 客户端）
$bytes = [IO.File]::ReadAllBytes("$env:APPDATA\TRAE SOLO CN\User\globalStorage\storage.json")
Set-Clipboard ([Convert]::ToBase64String($bytes))
Write-Host "已复制到剪贴板"
```

**CMD — 同样按产品二选一：**

```cmd
:: Trae CN（新版 IDE）
certutil -encode "%APPDATA%\Trae CN\User\globalStorage\storage.json" storage.b64
type storage.b64
```

```cmd
:: TRAE SOLO CN（SOLO 客户端）
certutil -encode "%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json" storage.b64
type storage.b64
```

> 两个客户端都装过时，最常见的坑是：明明刚登录过，导出的却是另一个产品的旧文件，表现为工作流一直 `NO_SESSION`（code 1001）。用上面的自动挑选命令可以避免。

---

### 2. 添加 GitHub Secret

1. 进入你的 GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions**
2. 点击 **New repository secret**
3. Name 填：`TRAE_CREDENTIALS_BASE64`
4. Value 粘贴导出的 Base64 字符串
5. 点击 **Add secret**

---

## 👥 多人 / 多账号配置指南

脚本原生支持批量多账号签到。添加多账号有以下两种方式（任选其一）：

### 方式 A：单 Secret 多行粘贴（推荐，最简便）
在 `TRAE_CREDENTIALS_BASE64` 中，**一行粘贴一个账号的 Base64 字符串**（按回车换行）：

```text
<账号1的Base64字符串>
<账号2的Base64字符串>
<账号3的Base64字符串>
```

### 方式 B：多个 Secret 环境变量
也可以分别创建多个 Secret：
- `TRAE_CREDENTIALS_BASE64`（主账号）
- `TRAE_CREDENTIALS_BASE64_2`（账号 2）
- `TRAE_CREDENTIALS_BASE64_3`（账号 3）
...以此类推（最多支持 20 个）。

---

### 3. 手动测试与工作流状态

进入 **Actions** → **Trae 每日签到** → **Run workflow** 手动触发一次：
- **签到成功**：工作流显示绿色对勾 `✅`，日志输出各账号签到状态与获得积分。
- **签到失败 / 异常**：如果存在任何账号未成功签到（如 Token 过期、网络异常、风控拦截），脚本将以退出码 `1` 退出，工作流明确显示红色叉号 `❌`，便于及时收到邮件告警。

---

### 4. 自动执行与仓库保活

- **定时执行**：工作流每天 **北京时间 06:00** 自动执行，附带 0~59 秒随机延迟与账号间平滑请求。
- **防休眠保活**：仓库内置 `keepalive.yml`，每周自动提交一次保活时间戳，防止 GitHub Actions 因 60 天无活动被停用。

---

## 常见问题与故障排查

| 错误代码 / 提示 | 说明 | 解决方案 |
|---|---|---|
| `NO_AUTH` | 凭证解密失败或未登录 | 本地重新在 Trae 登录后重新导出 Base64 更新 Secret |
| `NO_SESSION` / 401/403 | Token 登录态已过期 | 重新在 Trae 客户端登录后重新导出凭证更新 Secret |
| `NO_SESSION`（code 1001） | 导出的是**另一个产品**的旧 `storage.json`（常见于同时装了 Trae CN 与 TRAE SOLO CN） | 对照「原理」里的两条路径，导出最近登录过的那个；本机运行脚本会自动选最新，云端只能靠 Secret |
| `REFRESH_FAIL` | 无法云端续期 Token | 本地客户端重新登录并重新导出 |
| `REFRESH_FAIL 响应中无 Token` | 旧版本脚本解析不了 `Result.Result.Token` | 更新到最新脚本 |
| `server_busy` (9074) | 风控拦截（已通过 Aha Device ID 修复） | 更新最新版本脚本即可解决 |
| Actions 标记 `❌` | 任意账号签到未成功 | 点击进入该次运行查看具体哪一个账号报错并排查 |
