# Security Notes

本文档记录 Antigravity Cockpit（VS Code 扩展）与 Cockpit Tools（桌面端服务）之间
本地 WebSocket 通道的安全模型、已知缺口与加固方案。

## 架构

```
VS Code 扩展 (本仓库, Node)
  └─ ws://127.0.0.1:<ws_port>  (WSL 下为 Windows 侧网关 IP)
       └─ Cockpit Tools 桌面端 (独立 Rust 项目，不在本仓库)
```

- 端口来自共享目录 `~/.antigravity_cockpit/server.json` 的 `ws_port`，回退默认 `19528`。
- 消息为明文 JSON，无 TLS（本机回环）。
- 协议中存在高敏感 RPC：
  - `request.get_accounts_with_tokens` —— 返回全部账号的明文 `access_token` + `refresh_token`
  - `request.add_account` / `request.delete_account` —— 增删账号
  - `event.plugin_switch_account` —— 驱动切换当前活跃账号

## 凭据存储边界

| 数据 | 存储位置 | 权限 |
|---|---|---|
| 扩展自身 OAuth 凭据 | VS Code `SecretStorage`（macOS Keychain / Windows Credential Manager / libsecret） | 系统托管 |
| 扩展写入的配额/模型缓存、同步设置 | `~/.antigravity_cockpit/cache/**`、`sync_settings.json` | 目录 700 / 文件 600（`src/shared/secure_fs.ts` 统一强制） |
| 桌面端账号库（含 token 文件） | `~/.antigravity_cockpit/accounts/**`（桌面端写入，扩展只通过 WS 或索引读取） | **由桌面端负责，须 600** |

## 已知缺口（需桌面端配合，扩展侧无法单独闭环）

### WS-1：本地 WS 无连接鉴权（高）

任何本机进程都可连接该端口；若桌面端不校验 `Origin`，**浏览器中的恶意网页也可通过
JavaScript 发起 `ws://127.0.0.1:<port>` 连接**（WebSocket 不受同源策略限制），进而：

1. 调用 `request.get_accounts_with_tokens` 窃取全部明文 OAuth token；
2. 调用 `event.plugin_switch_account` 静默切换账号。

**桌面端必须实现（两者都要）：**

1. **Origin 校验**：拒绝浏览器来源的握手（浏览器 WS 必带 `Origin` 头；
   本机原生客户端默认不带，可据此放行无 Origin 的连接，仅拦截 http/https Origin）。
2. **握手共享密钥**：
   - 桌面端启动时生成随机 token，写入 `server.json`（文件权限 600），字段如 `auth_token`；
   - 扩展读取后在连接建立的首条消息发送握手：
     ```json
     { "type": "hello", "payload": { "client": "vscode-extension", "protocol": 1, "auth_token": "<token>" } }
     ```
   - 桌面端在收到有效握手前不接受任何 RPC，校验失败立即关闭连接（建议 close code 4401）。
   - 旧版扩展不发送握手 → 桌面端可按版本宽限期降级，但应记录安全警告。

### WS-2：明文 token 拉取面（中，扩展侧已最小化）

扩展双向同步账号时历史上**每次**都调用 `get_accounts_with_tokens`。
现已改为：先用不含 token 的 `request.get_accounts` 比对账号集合，
仅当存在"远端有、本地无"的账号时才拉取一次带 token 清单（见 `src/services/cockpitToolsSync.ts`）。
桌面端仍可进一步将该 RPC 拆分为按需单账号授权。

## 扩展侧已实施的加固

- 敏感缓存/设置文件统一 600、目录 700（`src/shared/secure_fs.ts`）。
- 入站 `event.plugin_switch_account` / `event.plugin_set_switch_mode` 强制 payload 为对象，
  且切号必须携带非空 `target_email`，否则在 WS 边界直接丢弃（`src/services/cockpitToolsWs.ts`）。
- Webview CSP：`default-src 'none'` + 随机 nonce 脚本（`src/view/hud.ts`）。
- 自身凭据只存 `SecretStorage`，不写入明文文件。

## 报告漏洞

请通过 GitHub Issues 私密披露，标题前缀 `[security]`。
