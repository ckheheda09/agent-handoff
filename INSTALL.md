# Agent Handoff 安装指南

适用于 **0.6.0**。本指南用于在目标电脑上配置宿主接力技能和 MCP 插件，可由用户手动执行，也可直接交给有终端与本机文件权限的 Agent 执行。

本指南假定管理员已经部署 Agent Handoff Relay。尚无服务时，先按 [Ubuntu 部署指南](agent-handoff-relay/docs/DEPLOY-UBUNTU.md) 部署，并在 [管理后台](agent-handoff-relay/docs/ADMIN.md) 登记设备。客户端安装不需要服务器 root 权限。

## 给执行安装的 Agent

目标是完成客户端构建、配置与验证。请使用当前用户权限执行，保留已有宿主配置，只安装用户选择的接入项。只询问缺少的必要参数；不要把示例值当成真实配置。

设备凭证 JSON 应由用户或管理员通过私有渠道提供并保存在本机。不要生成虚假令牌，不要把凭证、私钥或完整私有配置写入聊天、日志或 Git。配置完成后，还需要宿主重启或重载 MCP 才能验证真实连接。

## 1. 收集必要参数

| 参数 | 从哪里获取 / 要求 | 示例 |
| --- | --- | --- |
| `AGENTS` | 用户选择的宿主；可逗号多选 | `hermes`、`codex`、`chatgpt`、`dsh,hermes` |
| `RELAY_URL` | 管理员提供的传输 API 基地址；与后台地址可能不同 | `https://relay.example.com` |
| `CREDENTIALS` | 本设备专用凭证 JSON 的本机绝对路径 | `/absolute/private/device.json` |
| `WORKSPACE` | 用户允许交接文件的、已存在的目录 | `/absolute/workspace` |
| `PROFILE` | 本机中转配置名 | `office` |
| `CA`（按需） | 私有 CA 的 PEM 证书绝对路径；公开 CA 可省略 | `/absolute/private/relay-ca.crt` |

以上是参数说明，命令示例直接使用对应值，不要求设置同名环境变量。可从凭证 JSON 的 `relay_url` 获取服务地址；管理员另有新入口时，先核对。确认凭证含 `device_id`、`token`、`relay_url`，无需在输出中展示其内容。

每台设备使用独立凭证，不要复制另一台电脑的设备身份或 age 私钥。多个宿主可以在同一设备、同一 profile 下共用设备身份。

### 选择宿主

| `--agents` 值 | 宿主 | 默认配置文件 |
| --- | --- | --- |
| `dsh` | DeepSeek Harness 桌面 / CLI | `~/.dsh/profiles/desktop/cordis.patch.yml` |
| `hermes` | Hermes | `~/.hermes/config.yaml` |
| `codex` | Codex Linux / CLI | `~/.codex/config.toml` + `~/.agents/skills/relay/` |
| `chatgpt` | ChatGPT 桌面客户端 | `~/.agents/skills/relay-chatgpt/`；普通聊天通过安全隧道 |

安装器只配置所选接入，不安装宿主本身。旧 `openai` 参数等同 `codex`。详细原生入口、重载方法、ChatGPT 账号连接步骤见 **[HOSTS.md](HOSTS.md)**；需要 ChatGPT 普通聊天时，还要完成其中的安全隧道连接。

DSH 默认 profile 是 `desktop`，可传 `--dsh-profile NAME`。支持 `DSH_HOME`、`HERMES_HOME`、`CODEX_HOME`，以及 `--dsh-config FILE`、`--hermes-config FILE`、`--codex-config FILE`（旧 `--openai-config` 仍可用）。

## 2. 检查环境并构建安装包

需要 Git、Node.js **22.18+** 和随附的 npm/npx。检查：

```sh
git --version
node --version
npm --version
npx --version
```

目标宿主应已安装；本地使用需要终端或 stdio MCP 能力，ChatGPT 普通聊天走安全隧道。工作目录应已存在；尚未确定目录时向用户确认，不要把整个用户主目录作为默认交接范围。

**当前没有 npm registry 发布。不要直接运行 `npx agent-handoff-connect`。** 在适合保存源码的位置执行：

```sh
git clone https://github.com/ckheheda09/agent-handoff.git
cd agent-handoff/agent-handoff-connect
npm ci
npm pack
```

`npm pack` 通过 `prepack` 自动构建，生成 `dist/cli.mjs` 和 `agent-handoff-connect-0.6.0.tgz`。每条命令成功后再执行下一条；失败时先处理错误。

如果已有同名目录，先确认它是否为本仓库及是否有用户修改；不要覆盖目录或强制重置。可以改用新的克隆目录。记录 `git rev-parse HEAD`，用于最终报告所安装的源码版本。

后续命令都在 `agent-handoff-connect` 目录执行。Node.js 可执行文件路径会写入宿主配置，应使用宿主运行时也能访问的稳定安装位置。

## 3. 执行非交互式配置

下面示例只接入 Hermes。替换所有示例值；用户选择其他宿主时修改 `--agents`。

### macOS / Linux（sh、bash、zsh）

公开 CA 或系统已信任的 HTTPS 服务：

```sh
npx --yes --package ./agent-handoff-connect-0.6.0.tgz agent-handoff setup --yes \
  --agents hermes \
  --relay https://relay.example.com \
  --credentials /absolute/private/device.json \
  --workspace /absolute/workspace \
  --profile office
```

私有 CA 服务使用完整命令：

```sh
npx --yes --package ./agent-handoff-connect-0.6.0.tgz agent-handoff setup --yes \
  --agents hermes \
  --relay https://relay.example.com \
  --credentials /absolute/private/device.json \
  --ca /absolute/private/relay-ca.crt \
  --workspace /absolute/workspace \
  --profile office
```

路径含空格时加引号。CA 应由管理员提供并通过可信渠道核对；保留证书校验。

### Windows PowerShell

```powershell
npx --yes --package ./agent-handoff-connect-0.6.0.tgz agent-handoff setup --yes `
  --agents hermes `
  --relay https://relay.example.com `
  --credentials "C:\Users\you\Private\device.json" `
  --workspace "C:\Users\you\Projects\work" `
  --profile office
```

私有 CA 同样在 setup 命令增加 `--ca "C:\Users\you\Private\relay-ca.crt"`。反引号必须是续行的最后一个字符。Windows 已有路径和 ACL 适配，尚未完成原生桌面验收；安装后需在目标电脑实际验证。

### 自动化也可直接使用构建产物

如果不需要通过 npx 启动，使用同样的参数运行：

```sh
node dist/cli.mjs setup --yes \
  --agents hermes \
  --relay https://relay.example.com \
  --credentials /absolute/private/device.json \
  --workspace /absolute/workspace \
  --profile office
```

两种方式调用相同安装器。自动执行时保留 `setup --yes`，避免等待交互输入。需要手动向导时，可运行：

```sh
npx --yes --package ./agent-handoff-connect-0.6.0.tgz agent-handoff
```

### 安装器会做什么

1. 校验 Relay、设备凭证及设备 ID。
2. 检查 age / age-keygen；缺少时下载固定官方 **1.3.2** 并核对预置 SHA-256。
3. 生成或复用本机 age 身份，向 Relay 登记公钥。
4. 将构建产物复制到固定私有运行目录，避免依赖 npx 缓存。
5. 备份并合并所选宿主配置，安装原生接力技能及绑定路由的脚本，保存本机 profile。

成功输出应包含 `"status": "configured"`，以及 profile、设备 ID、工作目录、运行程序路径和配置变更列表。令牌不会出现在成功输出中。

原宿主配置修改前会生成 `.handoff-backup-*` 备份。遇到同名条目或用户修改过的受管理条目，安装器会停止，不能靠删除用户配置绕过。

## 4. 检查客户端配置

在同一目录、同一用户和同一 profile 下执行：

```sh
npx --yes --package ./agent-handoff-connect-0.6.0.tgz agent-handoff doctor --profile office
npx --yes --package ./agent-handoff-connect-0.6.0.tgz agent-handoff profiles
npx --yes --package ./agent-handoff-connect-0.6.0.tgz agent-handoff peers --profile office
npx --yes --package ./agent-handoff-connect-0.6.0.tgz agent-handoff inbox --profile office
```

也可将每条命令的 `npx ... agent-handoff` 替换为 `node dist/cli.mjs`。

验收要求：

- `doctor` 退出码为 0，JSON 顶层 `ok` 为 `true`；Relay、设备公钥、本地私钥、工作目录和所选宿主配置检查均通过。
- `profiles` 显示期望的中转地址、设备、工作目录和所选宿主。
- `peers` 与 `inbox` 能正常返回；空收件箱属于正常结果。

`doctor` 验证配置和服务访问，不证明宿主已加载插件。

## 5. 验证宿主接入

先按 [HOSTS.md](HOSTS.md) 验证原生入口：DSH / Hermes 的 `/relay`、Codex 的 `$relay`、ChatGPT 桌面技能。原生脚本可独立于 MCP 收发，但单次调用不提供后台提醒。

需要 MCP 工具和持续通知时，重启目标宿主或使用其 MCP 重载功能。安装时正在运行的 Agent 通常不会立即获得新工具；如果无法从当前会话重载，应说明需要用户重启并记录待验证项。

让目标宿主中的 Agent 执行：

```text
调用 handoff_connection 检查连接。
调用 handoff_devices 查看设备。
调用 handoff_inbox 检查收件箱。
报告设备 ID、路由和连接结果，不展示令牌或私钥。
```

实际能调用上述工具，才表示该宿主 MCP 已连通。管理员还可在后台查看该宿主的 Agent 心跳；心跳在 MCP 客户端初始化后每 30 秒上报，桥接进程退出后停止。

需要完整收发验收时，使用两个独立设备身份，在用户指定工作目录中准备不含敏感信息的小文件，发送到已确认的设备与路由；接收后核对文件内容、摘要和 `verified` 回执。发送前应明确测试接收方与文件。只有实际接受、开始或完成任务后，才记录相应回执。

## 日常使用：只说一句话

两端配置完成并重载 MCP 后：

- 发送：**“接力到办公室电脑。”**（替换成实际设备名称或 ID。）
- 接收：**“接力。”**

发送端 Agent 会整理当前会话的上下文、待办和必要文件，调用统一 `handoff` 工具；插件自动发现设备与 Agent 路由。接收端只有一条待办时自动领取，多候选时只需选择，不要求用户记住工具名或填写技术参数。

新版默认启用新交接系统提醒：MCP 连接期间每 10 秒检查，合并提醒并持久去重。安装参数 `--notifications off` 关闭系统提醒，`--notifications system` 开启；MCP 日志通知保留。实际显示需要桌面会话和系统通知权限。macOS 使用系统通知，Windows 提示框和 Linux `notify-send` 尚需目标设备实机验证；无桌面时保留日志通知。

可运行 `agent-handoff notify-test --profile office` 请求一条系统测试提醒（使用本文的完整 npx 前缀）。状态为 `submitted` 仅表示系统接收了请求，不保证屏幕显示。插件不会自动启动已退出的宿主或因通知自动接受、执行任务。

### 从 0.3.0 / 0.4.0 升级

获取本版源码构建的 0.6.0 包，使用原来的 `--home`、`--profile`、工作目录及完整宿主列表重跑 setup；保留原私有配置和 age 身份。已有 profile 可以省略 `--credentials`，无需更新设备令牌。完成后重启/重载宿主，确认宿主已发现接力技能；MCP 工具列表包含 `handoff_publish_session`、`handoff_sessions`、`handoff_resume_session`。会话库使用见 [SESSIONS.md](SESSIONS.md)。只更新中转服务器不会升级已安装的本地插件。

## 可选：SSH 隧道

仅当 Relay 在服务器的 `127.0.0.1:17860` 监听、且目标设备有该服务器 SSH 访问权限时使用。SSH 用户、主机及端口由管理员提供。

先在单独终端建立并保持隧道：

```sh
ssh -N -L 17860:127.0.0.1:17860 -p 22 USER@HOST
```

随后执行安装，显式允许回环 HTTP：

```sh
npx --yes --package ./agent-handoff-connect-0.6.0.tgz agent-handoff setup --yes \
  --agents hermes \
  --relay http://127.0.0.1:17860 \
  --allow-loopback-http \
  --credentials /absolute/private/device.json \
  --workspace /absolute/workspace \
  --profile office
```

此方式仍需要有效设备凭证。仅允许显式启用的回环 HTTP；不要换成公网明文地址。隧道关闭后客户端会断开，日常使用需要保持隧道运行。

## 可选：使用管理员分发的 tgz

如果已有可信管理员提供的 **0.6.0** tgz，可以跳过源码构建。先核对来源和管理员提供的摘要，在安装包所在目录执行第 3 步；仓库没有预置 GitHub Release 安装包。

若管理员明确启用了后台下载入口，可使用其提供的真实 HTTPS 地址。下面地址只是示例，不能假定某个部署已经提供此文件：

```sh
npx --yes --cafile /absolute/private/relay-ca.crt \
  --package=https://relay.example.com:17862/downloads/agent-handoff-connect-0.6.0.tgz \
  agent-handoff setup --yes \
  --agents hermes \
  --relay https://relay.example.com:17861 \
  --credentials /absolute/private/device.json \
  --ca /absolute/private/relay-ca.crt \
  --workspace /absolute/workspace \
  --profile office
```

`--cafile` 用于 npm 下载 tgz 时的 TLS 校验，setup 的 `--ca` 用于插件连接 Relay，两者用途不同。公开 CA 部署可省略对应证书参数。

## 重配、多 profile 与卸载

- 重新配置：使用完整 setup 命令和相同 `--profile`。`--agents` 应填写该 profile 最终要保留的完整宿主列表；未列出的原受管理宿主条目会被移除。
- 切换服务或身份：可使用新 `--profile` 分开保存。已有 profile 不允许换成另一设备 ID。
- CA 改为系统信任：setup 增加 `--ca system`；非交互重配省略 `--ca` 会沿用该 profile 的原私有 CA。
- 自定义插件数据目录：setup 增加 `--home DIR`，后续命令也使用同一目录；或一致设置 `AGENT_HANDOFF_HOME`。
- 路由配置：`--agent-profile NAME` 指定中转路由的 `profile_id`，默认 `default`；它与 `--profile office`、`--dsh-profile desktop` 用途不同。

卸载指定 profile 的受管理 MCP 接入和技能文件：

```sh
npx --yes --package ./agent-handoff-connect-0.6.0.tgz agent-handoff uninstall --profile office
```

卸载保留设备凭证、age 私钥、重试缓存和接收文件。重启宿主使配置生效。不要为重装而删除身份目录：私钥丢失会导致旧密文无法解密。

默认私有数据位置：macOS/Linux 为 `~/.config/agent-handoff`，Windows 为 `%LOCALAPPDATA%/AgentHandoff`。Unix 目录权限 0700、文件 0600；Windows 使用当前用户 ACL。备份应通过私有方式保存，不放入源码仓库。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| npx 找不到包 | 当前未发布到 npm；从源码 `npm pack`，使用 `--package ./agent-handoff-connect-0.6.0.tgz`。 |
| Node.js 版本不满足 | 客户端要求 22.18+；Relay 要求 24.22.1+ 的 24.x。宿主还需能访问安装时使用的 Node 路径。 |
| TLS / 证书错误 | 核对服务地址与 CA；setup 使用 `--ca`，远程下载包另用 `--cafile`。保留证书校验。 |
| 401 / 403 或设备 ID 不匹配 | 核对 Relay URL、凭证所属设备和是否已撤销；请管理员提供正确凭证。 |
| Relay 不兼容 / 404 | 使用传输 API 基地址，检查是否误填管理后台地址；Relay 不是远程 MCP `/mcp` 端点。 |
| 无法下载 age | 提供已安装的 `--age-bin FILE --age-keygen FILE --no-download-age`；不要省略 age 加密。 |
| 同名 MCP 配置冲突 | 检查已存在条目的来源与用户修改；使用新的 profile 或由用户决定如何处理冲突。 |
| 同一设备的公钥冲突 | 恢复本设备原私钥；无法恢复时由管理员登记新设备，使用新 profile。 |
| `doctor` 通过但没有工具或心跳 | 重启/重载正确的宿主，检查 MCP 启动日志、Node 路径及实际配置文件。 |
| 收件箱为空 | 正常；确认其他设备已发送到正确设备、adapter 和路由 profile。 |
| setup 锁残留 | 先确认无安装或卸载进程正在操作，再按错误提示处理具体锁目录；不要盲删整个配置目录。 |

## 完成报告模板

执行安装的 Agent 应给出以下结果，避免只回复“已安装”：

```text
安装版本 / 源码提交：0.6.0 / <实际 commit>
目标宿主：<实际选择>
设备 ID / 中转配置名：<device_id> / <profile>
中转地址 / 工作目录：<实际值>
修改的配置文件 / 备份位置：<安装器返回的路径>
doctor：通过 / 未通过，失败项为……
宿主 MCP：已实际调用工具验证 / 等待宿主重启 / 验证失败
测试收发：已完成及对应 ID / 未执行
剩余操作：<如需用户重启，明确说明；无则写无>
```

更多 CLI、工具与文件边界见 [客户端说明](agent-handoff-connect/README.md)；已测平台与未验收范围见 [验证记录](agent-handoff-relay/docs/VALIDATION.md)。
