# trae-auto-signin

自动领取 **TRAE SOLO CN** 每日签到积分的 Node.js 脚本。

自包含的单文件脚本，每天自动领取签到积分。零依赖 · 纯标准库 · 跨平台 · 幂等安全 · 多人多账号批量签到。

> 本项目基于 Trae 客户端本地凭据存储与协议逆向实现。

## 特性

- **零依赖**：仅用 Node.js 标准库，16+ 版本即可直接运行。
- **多人多账号支持**：支持多行 Base64、多 Secret、多本地凭证文件，批量轮流签到并汇总汇报。
- **智能防风控**：自动解析 Trae 官方客户端 16 位数字 Aha 设备 ID（`iCubeAuthInfo://icube-dc:<id>`），彻底规避 9074（`当前参与用户太多，请稍后再试`）风控拦截。
- **幂等安全**：先查询状态，未签到才领取，当天重复运行不会多领。
- **凭证解密**：自动解密本地 `storage.json`（byteCrypto 信封格式 + AES-128-CBC + SHA-512 校验）。
- **Token 自动刷新**：支持 ECDSA P-256 设备证明签名临期自动续期。
- **严格失败拦截**：只要有任一账号未成功签到，脚本均返回退出码 `1`，GitHub Actions 工作流直接标记为失败（`❌`），便于及时接收邮件通知。

## 快速开始

```bash
node signin.js auto
```

## 命令列表

| 命令 | 说明 |
|---|---|
| `auto` | 每日自动化（全账号签到，默认命令） |
| `status` | 仅查询所有账号签到状态（调试用） |
| `claim` | 仅领取所有账号签到奖励（调试用） |
| `refresh` | 仅刷新所有账号 Token（调试用，需先关闭 Trae 客户端） |

输出示例：

```text
📦 检测到 2 个 Trae 账号，开始批量签到...
[1/2] 🎉 账号 [用户5***10]: 签到成功 (+200 积分)
[2/2] ✅ 账号 [用户8***23]: 今日已签到
[RESULT] {"command":"auto","total_accounts":2,"successful_accounts":2,"failed_accounts":0,"all_success":true,"results":[...]}

✨ 全部账号签到成功 (2/2)
```

## 凭证来源与环境变量

| 环境变量 | 说明 |
|---|---|
| `TRAE_CREDENTIALS_BASE64` | 单账号或多账号 Base64（多账号按换行分隔或传入 JSON 数组） |
| `TRAE_CREDENTIALS_BASE64_1...20` | 支持分别指定多个账号的 Base64 Secret |
| `TRAE_STORAGE_DIR` | 本地包含多个 `*.json` 凭据的目录路径 |
| `TRAE_STORAGE_JSON` | 本地自定义 `storage.json` 文件路径（逗号分隔支持多个） |

本地直接运行默认读取：
`%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`

## GitHub Actions 云端自动化

详细多账号部署指南请参阅 [SETUP-GITHUB.md](./SETUP-GITHUB.md)。

1. **Fork 本仓库**
2. **配置 Secret**：在 Settings -> Secrets 中添加 `TRAE_CREDENTIALS_BASE64`（多账号一行一个）。
3. **开启 Actions**：工作流每天 **北京时间 05:00** 自动执行签到。

## 排错指南

| 错误状态 | 说明 | 解决方案 |
|---|---|---|
| `NO_AUTH` | 凭证解密失败或未登录 | 在 Trae 客户端重新登录后重新导出 Base64 |
| `NO_SESSION` (401/403) | 登录态已过期 | 重新登录 Trae 并更新 GitHub Secret |
| `server_busy` (9074) | 风控拦截 | 当前版本已修复（确保使用最新脚本） |
| `verify_failed` | 签到奖励未确认 | 检查活动是否仍在开放期 |

## 免责声明

本项目为非官方工具，与 Trae 及其开发方无隶属关系。接口由桌面客户端逆向获得，仅供学习研究，使用风险自负。

## 协议

MIT 开源许可。
