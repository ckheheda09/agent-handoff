# 0.3.0 多端 MCP 插件

当前推荐使用相邻目录 `agent-handoff-connect` 的 npx 安装器。支持 DeepSeek Harness、Hermes、ChatGPT 桌面客户端、Codex Linux，自选 Agent、自定义中转服务、CA 和工作目录，提供加密上下文与实际文件交接、MCP 心跳、收件箱和回执。

完整安装说明见 [插件 README](../../agent-handoff-connect/README.md)。管理员可按 [下载目录说明](../web/downloads/README.md) 发布安装包和自己的 CA；后台“接入 Agent”展示命令。以下保留手动 CLI 的使用说明。

# Windows、Linux、macOS 客户端

本版通过命令行收发加密交接包。三端使用同一份源码，不需要 npm install；本机不开放入站端口。以下命令从解压后的 `agent-handoff-relay` 目录执行。

## 1. 安装运行环境

各端安装 Node.js 24.22.2，以及 age、age-keygen：

| 系统 | Node.js | age |
|---|---|---|
| Windows | 官方 Windows 安装包，按 x64/ARM64 选架构 | 从 age 官方 Release 下载对应 Windows 压缩包，将两个 exe 放进 PATH |
| Linux | 官方 24.22.2 Linux 包，按 x64/ARM64 选架构 | Ubuntu 可用 `sudo apt install age`，其他发行版按 age 官方说明安装 |
| macOS | 官方 macOS 安装包，按 Apple Silicon/Intel 选架构 | 已装 Homebrew 时用 `brew install age`，或使用官方 macOS 压缩包 |

验证：

```sh
node --version
age --version
age-keygen --version
tar --version
```

只使用 age 的二进制输出，不加 `--armor`。本版服务检查二进制 age-v1 文件头。各端都有 tar 时可直接执行下面的归档命令；否则先安装归档工具。

官方入口：[Node.js 24.22.2](https://nodejs.org/dist/v24.22.2/)、[age 安装说明](https://github.com/FiloSottile/age#installation)、[age Release](https://github.com/FiloSottile/age/releases)。本地已验证 Node 24.22.2 与 age 1.3.2；不要求服务器安装 age，因为服务器不解密。

## 2. 一次性准备设备凭证和解密密钥

两种文件各有用途：

- 管理员从中转服务器交付的设备 JSON：允许访问收件箱和发送文件。
- 每台电脑自己生成的 age 私钥：解密发给自己的交接包。私钥保留在本机；给发送者的是公钥。

macOS/Linux：

```sh
mkdir -p "$HOME/.config/agent-handoff"
chmod 700 "$HOME/.config/agent-handoff"
# 把管理员交付给本设备的 JSON 保存为该目录下的 device.json。
chmod 600 "$HOME/.config/agent-handoff/device.json"
age-keygen -o "$HOME/.config/agent-handoff/age-identity.txt"
chmod 600 "$HOME/.config/agent-handoff/age-identity.txt"
age-keygen -y "$HOME/.config/agent-handoff/age-identity.txt"
```

Windows PowerShell：

```powershell
$private = "$env:LOCALAPPDATA\AgentHandoff"
New-Item -ItemType Directory -Force $private | Out-Null
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $private /inheritance:r /grant:r "${account}:(OI)(CI)F"
# 把管理员交付给本设备的 JSON 保存为 $private\device.json。
age-keygen -o "$private\age-identity.txt"
age-keygen -y "$private\age-identity.txt"
```

保管好输出的 `age1...` 公钥，标明对应设备，通过已有可信渠道交给发送端。服务端不提供公钥发现；`--to mac-home` 只控制路由，不会自动把文件加密给 Mac。发送前确认公钥与目标设备匹配。

密钥生成命令只执行一次；不要覆盖已有私钥。设备 JSON 和私钥不要放进任务目录、代码发布包或聊天消息。Windows 文件权限依赖本机 ACL，Node 的 `0600` 不能代替 ACL。

## 3. 确认连接

macOS/Linux：

```sh
CRED="$HOME/.config/agent-handoff/device.json"
node bin/client.mjs whoami --credentials "$CRED"
```

PowerShell：

```powershell
$cred = "$env:LOCALAPPDATA\AgentHandoff\device.json"
node bin/client.mjs whoami --credentials $cred
```

返回的 `device_id` 应与本机相符。默认使用凭证中的 HTTPS 地址。

还没有域名时，在另一个终端保持 SSH 隧道：

```sh
ssh -N -L 17860:127.0.0.1:17860 你的SSH用户名@relay.example.com
```

然后为下文**每条**客户端命令加上 `--tunnel-url http://127.0.0.1:17860`。这个参数只接受回环 HTTP 地址。服务端注册地址仍可暂填 `https://relay.invalid`。不要使用 `--allow-local-http true` 绕过远程 HTTPS；该选项仅供本机开发测试。

## 4. 准备包含会话和实际文件的交接包

在来源电脑创建一个单独的目录：

```text
handoff/
├── HANDOFF.md
├── conversation.json
├── inputs/
└── outputs/
```

`HANDOFF.md` 写明任务目标、限制、已确认决定、进度和下一步；`conversation.json` 放实际取得的会话导出。普通文字转录也可以用 `conversation.md`。输入、产出目录放实际字节，使用相对路径。

这是通用文件包，不是 DSH/Hermes/ChatGPT 原生会话格式。本版不读取客户端会话库，也不生成会话摘要。只导出到的聊天、附件和工具记录才能放入包；缺失内容在 HANDOFF 中说明。

macOS/Linux，从 `handoff` 的父目录执行：

```sh
tar -czf handoff.tar.gz handoff
age -r 'age1替换为接收设备公钥' -o handoff.tar.gz.age handoff.tar.gz
```

PowerShell：

```powershell
tar -czf handoff.tar.gz handoff
age -r 'age1替换为接收设备公钥' -o handoff.tar.gz.age handoff.tar.gz
```

需要让来源电脑也能解密时，age 命令再加一个 `-r 来源设备公钥`。本版没有发送者签名；拥有设备凭证的人可以代表该设备投递，不能据此证明某段文字由哪个模型生成。

## 5. 发送与断点续传

回到源码目录。把 `--file` 改成刚生成密文的实际路径：

```sh
node bin/client.mjs send --credentials "$CRED" --file /实际路径/handoff.tar.gz.age --to mac-home --id report-20261030-01 --adapter generic --profile default
```

PowerShell：

```powershell
node bin/client.mjs send --credentials $cred --file 'C:\实际路径\handoff.tar.gz.age' --to mac-home --id report-20261030-01 --adapter generic --profile default
```

- `--to` 是管理员登记的目标设备 id。
- `--id` 为本次投递的固定标识，只用字母、数字、下划线、连字符，最多 80 字符。
- 中途断网后，保留同一份密文，重跑**完全相同的命令**即可从服务端确认的 offset 继续。不要重新加密；age 重新加密会生成不同密文。
- 传送新版本、交回或转给第三端时，使用新的 id。
- `--adapter`、`--profile` 是留给后续适配器的路由标记；填写 `hermes.desktop` 不会自动启动 Hermes。

进度写到 stderr，最终 JSON 写到 stdout；最终 `status: ready` 表示中转已接收完整密文并校验摘要，尚不表示目标设备已接管。命令失败退出码为 1，不会无限自动重试。

## 6. 接收、解密和检查

在目标电脑执行；此处的 CRED/cred 是目标电脑自己的凭证：

```sh
node bin/client.mjs inbox --credentials "$CRED"
node bin/client.mjs download --credentials "$CRED" --id report-20261030-01 --out ./received/report-20261030-01.age
age -d -i "$HOME/.config/agent-handoff/age-identity.txt" -o ./received/report-20261030-01.tar.gz ./received/report-20261030-01.age
tar -tzf ./received/report-20261030-01.tar.gz
```

PowerShell：

```powershell
node bin/client.mjs inbox --credentials $cred
node bin/client.mjs download --credentials $cred --id report-20261030-01 --out .\received\report-20261030-01.age
age -d -i "$env:LOCALAPPDATA\AgentHandoff\age-identity.txt" -o .\received\report-20261030-01.tar.gz .\received\report-20261030-01.age
tar -tzf .\received\report-20261030-01.tar.gz
```

下载成功会返回 `bytes_verified: true`，指密文大小和 SHA-256 与中转记录一致。age 解密成功后，再检查目录清单和 HANDOFF。确认来源、路径和所需文件后，解压到一个新目录；不要直接覆盖已有项目，也不要执行陌生包中的脚本。

```sh
mkdir ./received/unpacked-report-01
tar -xzf ./received/report-20261030-01.tar.gz -C ./received/unpacked-report-01
```

PowerShell 同样可用 `mkdir` 和 `tar -xzf ... -C ...`。本版客户端不会自动解包；不验证包内 manifest，也不处理 Windows 保留文件名、跨系统大小写冲突、缺失依赖或原生会话导入。这些需要发送前检查。

下载中断后保留 `.part`，重跑相同 download 命令续传。若提示 `download_checksum_mismatch`，移走该 `.part` 再重新下载；程序不会把校验失败的文件发布为最终输出。已有最终输出若内容不同会被保留，使用新路径接收。

## 7. 回执与交回

确认解密和必要文件后，接收端按实际进度回传：

```sh
node bin/client.mjs receipt --credentials "$CRED" --id report-20261030-01 --state verified --request-id report-01-verified
node bin/client.mjs receipt --credentials "$CRED" --id report-20261030-01 --state accepted --request-id report-01-accepted
node bin/client.mjs receipt --credentials "$CRED" --id report-20261030-01 --state started --request-id report-01-started
node bin/client.mjs receipt --credentials "$CRED" --id report-20261030-01 --state completed --request-id report-01-completed
```

PowerShell 将 `"$CRED"` 替换为 `$cred` 即可。每个事件用不同 request-id，重试同一事件时保留原 request-id。只有实际完成工作后才发送 completed；不能直接从 pending 跳到 completed。

发送端查看：

```sh
node bin/client.mjs status --credentials "$CRED" --id report-20261030-01
node bin/client.mjs outbox --credentials "$CRED"
```

回执是接收设备声明，中转不会观察 Agent 是否执行。交回或转给第三端时，更新 HANDOFF、带上新产出、使用新接收者公钥加密，以新 id 再 send。所有登记设备都使用同样流程，不限定方向。

每页默认最多 100 条；下一页用 `inbox --after <next_cursor>`。游标只用于发现新投递，不是状态变更流；跟踪已知包的回执应调用 status。

## 8. 常见错误

| 错误 | 处理 |
|---|---|
| `unauthorized` | 核对本机凭证；可能已被撤销或轮换 |
| `recipient_unavailable` | 管理员检查目标设备 id 和启用状态 |
| `idempotency_conflict` | 同一 id 对应了不同文件或接收者；传新版本时换 id |
| `offset_conflict` | 避免两个进程同时发送同一 id；保留密文重跑单个命令 |
| `storage_quota_exceeded` | 管理员检查 stats，取消不再需要的包或等待过期 |
| `handoff_expired` / `handoff_cancelled` | 已无法继续，必要时以新 id 发新包 |
| `no identity matched` 等 age 错误 | 确认用了正确接收者公钥和对应私钥；中转无法修复加密对象错误 |

手动传输 CLI 不提供后台通知。新版 npx 插件提供宿主连接期间的系统提醒，详见仓库根目录 HOSTS.md。DSH、Hermes、ChatGPT 桌面客户端、Codex Linux 的本地 MCP 接入见相邻插件目录；手动 CLI 用户可把已解包目录和 HANDOFF 交给目标 Agent 继续处理。
