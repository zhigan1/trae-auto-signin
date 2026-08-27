# trae-auto-signin

自动领取 **TRAE SOLO CN** 每日签到积分的 Node.js 脚本。

自包含的单文件脚本，每天自动领取签到积分。零依赖 · 纯标准库 · 跨平台 · 幂等安全。

> 本项目基于 Trae 客户端本地凭证加密机制逆向实现。

## 特性

- **零依赖**：仅用 Node.js 标准库，16+ 版本即可运行
- **幂等安全**：先查询状态，未签到才领取，重复运行不会多领
- **凭证解密**：自动解密本地 `storage.json`（AES-128-CBC 信封格式 + SHA-512 完整性校验）
- **Token 自动刷新**：ECDSA P-256 设备证明签名临期续期
- **智能汇报**：以一行 JSON 汇总签到结果
- **健壮性**：能识别 401/403 登录态过期、活动未开启等情况
- 跨平台（Windows/macOS/Linux），可通过 GitHub Actions 定时执行

## 快速开始

```bash
node signin.js auto
```

## 命令列表

| 命令 | 说明 |
|------|------|
| `auto` | 每日自动化（签到，默认命令） |
| `status` | 仅查询签到状态（调试用） |
| `claim` | 仅领取签到奖励（调试用） |
| `refresh` | 仅刷新 Token（调试用，需先关闭 Trae 客户端） |

输出示例：

```
[RESULT] {"command":"auto","account":"用户5090","signed_in":true,"already_checked_in":false,"credits_gained":200,"token_refreshed":false,"error":null}
```

## 凭证来源

脚本从 Trae 客户端本地存储读取凭证：

```
%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json
```

本地直接运行无需任何配置；GitHub Actions 环境需将此文件导出为 Base64 后配置到 Secret，详见 [SETUP-GITHUB.md](./SETUP-GITHUB.md)。

| 环境变量 | 说明 |
|----------|------|
| `TRAE_STORAGE_JSON` | 自定义 storage.json 路径（可选） |
| `DEBUG` | 设为任意值输出调试信息 |

## Windows 定时任务

```bat
schtasks /create /tn "Trae每日签到" /tr "node C:\path\to\signin.js auto" /sc daily /st 05:00 /f
```

或把仓库里的 `signin.bat` 放入开机启动文件夹：

```
Win+R → shell:startup → 粘贴 signin.bat 快捷方式
```

## GitHub Actions 自动化

三步设置：

1. **Fork 本仓库**
2. **配置 Secret**：按 [SETUP-GITHUB.md](./SETUP-GITHUB.md) 导出凭证并添加 `TRAE_CREDENTIALS_BASE64`
3. **启用 Actions**：进入 Actions 页面确认工作流已启用

工作流每天**北京时间 05:00** 自动执行签到（带 0–59 秒随机延迟）。

另附 `keepalive.yml` 每周自动提交一次，防止 GitHub Actions 因 60 天无活动被禁用。

## 文件结构

```
trae-auto-signin/
├── .github/workflows/
│   ├── daily-signin.yml      ← 每日签到工作流
│   └── keepalive.yml         ← 仓库保活工作流
├── signin.js                 ← 多命令版主脚本
├── signin.bat                ← Windows 双击运行
├── SETUP-GITHUB.md           ← GitHub Actions 配置指南
└── README.md
```

## 排错

| 错误码 | 说明 | 解决方案 |
|--------|------|----------|
| `NO_STORAGE` | 未找到凭证文件 | 本地先登录 Trae，云端按 SETUP-GITHUB.md 导出凭证 |
| `NO_AUTH` | 凭证解密失败或未登录 | 在 Trae 客户端重新登录后重新导出 |
| `NO_SESSION` | 登录态已过期 (401/403) | Token 过期，重新导出凭证或重新登录客户端 |
| `REFRESH_FAIL` | Token 刷新失败 | 服务端设备公钥不匹配时无法云端刷新，请重新登录 Trae |
| `INACTIVE` | 签到活动未开启 | 属正常情况，跳过即可 |

## 免责声明

本项目为非官方工具，与 Trae 及其开发方无隶属关系。接口由桌面客户端逆向获得，可能随时变动。仅供学习研究，使用风险自负，勿用于商业用途。

## 协议

MIT 开源许可。
