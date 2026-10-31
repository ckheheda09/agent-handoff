# Agent Handoff

**让另一台设备上的 Agent 接着做：交接任务上下文，也交接实际文件。**

Agent Handoff 包含自建中转服务、Web 管理界面和本地 MCP 插件。发送端整理目标、已有结论、约束、待办与产物，接收端解密、校验后继续工作。当前客户端版本：**0.4.0**（Relay 0.3.0） · [MIT](LICENSE)。

[快速开始](#快速开始) · [交给 Agent 安装](#交给-agent-安装) · [支持的 Agent](#支持的-agent) · [部署中转服务](#部署中转服务) · [文档](#文档)

## 能做什么

- **一句话接力**：发送端说“接力到办公室电脑”，接收端说“接力”；插件自动发现设备与 Agent、查收和校验，多候选时再选择。
- **新交接提醒**：宿主 MCP 连接期间每 10 秒检查，提供系统提醒与 MCP 日志通知，按路由去重。
- **跨设备交接**：把任务说明和工作目录内明确选择的文件发送到指定设备及 Agent 路由。
- **本地 MCP 接入**：选择 DeepSeek Harness、Hermes 或兼容 Codex host 的 ChatGPT Desktop / Codex，配置自己的中转地址。
- **端到端文件加密**：发送端使用接收设备的 age 公钥加密；中转只保存密文与投递元数据。
- **持续传输与回执**：分块、断点续传、持久队列，以及校验、接受、开始和完成等状态。
- **Web 管理**：登记设备、下载专用凭证、轮换或撤销令牌，查看 Agent 心跳、上传下载进度、流量与回执。
- **多套服务配置**：用不同 profile 管理中转地址、设备身份、工作目录和 MCP 配置。

适合在办公室与家中的电脑之间继续同一项工作，或把已有产物交给另一台设备上的 Agent 处理。

## 如何工作

```mermaid
flowchart LR
    A[发送端 Agent] <-->|本地 MCP stdio| B[本地插件]
    B -->|age 加密后通过 HTTPS 上传| R[自建 Relay]
    R -->|下载密文| C[接收端插件]
    C <-->|本地 MCP stdio| D[接收端 Agent]
    M[Web 管理界面] -->|设备、心跳、进度、回执| R
```

文件包包含 `HANDOFF.md`、`manifest.json` 和 `files/`。接收端核对密文摘要、解密，再检查归档路径和逐文件摘要，将产物写入：

```text
<workspace>/.agent-handoff/inbox/<handoff-id>/
```

当前 MCP 使用本地 **stdio**；Relay 提供 HTTP 传输 API。安装器负责把本地插件接入宿主。

## 快速开始

已有中转服务时，只需在目标设备安装客户端。准备好：

1. Node.js **22.18+**、npm/npx 和 Git。
2. 已安装且支持本地 MCP 的目标 Agent。
3. 管理员提供的 Relay URL、本设备专用凭证 JSON；私有 CA 部署还需要 CA 证书。
4. 一个已存在、用于交接文件的工作目录。

**当前尚未发布到 npm registry。** 从源码生成安装包后再通过 npx 运行：

```sh
git clone https://github.com/ckheheda09/agent-handoff.git
cd agent-handoff/agent-handoff-connect
npm ci
npm pack
npx --yes --package ./agent-handoff-connect-0.4.0.tgz agent-handoff
```

`npm pack` 会自动构建。向导会让你选择 Agent，并填写凭证路径、中转地址、CA 和工作目录；不需要全局安装或 sudo。每台设备应使用独立凭证。

安装后重启宿主或重载 MCP，对 Agent 说：

> 调用 handoff_connection 检查连接，再调用 handoff_devices 和 handoff_inbox，报告连接结果和可接收设备。

完整参数、Windows PowerShell、私有 CA、SSH 隧道及故障处理见 **[安装指南](INSTALL.md)**。

## 交给 Agent 安装

将下面这段话交给目标设备上的 Agent，并填入自己的参数：

```text
请阅读 https://github.com/ckheheda09/agent-handoff/blob/main/INSTALL.md，
按其中“给执行安装的 Agent”说明完成本机安装和验证。

目标 Agent：hermes（可选 dsh、hermes、openai，按需多选）
中转服务：https://relay.example.com
设备凭证：/absolute/private/device.json
工作目录：/absolute/workspace
配置名称：office
CA：系统信任（私有 CA 则填写证书的本机绝对路径）

只询问缺少的必要信息；不要输出令牌或私钥。
请分别报告配置是否完成，以及宿主 MCP 是否已实际连通。
```

凭证应通过私有渠道交付并保存在目标设备本地；示例地址和路径需要替换。

## 支持的 Agent

| 安装参数 | 宿主 | 默认配置 |
| --- | --- | --- |
| `dsh` | DeepSeek Harness 桌面 / CLI | `~/.dsh/profiles/desktop/cordis.patch.yml` |
| `hermes` | Hermes | `~/.hermes/config.yaml` 的 `mcp_servers` |
| `openai` | 兼容 Codex host 的 ChatGPT Desktop / Codex | `~/.codex/config.toml` 的 `mcp_servers` |

`openai` 是共用配置选项，需要宿主版本实际支持本地 MCP；不代表所有 ChatGPT 客户端都能接入。安装器只配置插件，不安装这些宿主本身。自定义路径、DSH profile 和多服务配置见 [客户端说明](agent-handoff-connect/README.md)。

## 交接一个任务

两端安装插件并连接同一个 Relay 后，所有宿主都使用同样的说法：

发送端：**“接力到办公室电脑。”**

接收端：**“接力。”**

将“办公室电脑”换成后台的设备显示名称或 ID。发送端 Agent 整理当前会话上下文与必要文件；插件自动发现目标 Agent。接收端只有一条待办时直接领取并校验，有多个候选时让用户选择。

宿主连接期间默认每 10 秒检查新交接，请求系统提醒并发送 MCP 日志通知。显示依赖桌面和通知权限；宿主退出后不检查，也不会自动启动模型或导入原生聊天记录。配置方式与平台验证范围见 [客户端说明](agent-handoff-connect/README.md#一句话接力)。

统一工具 `handoff` 完成发现、发送或接收。原有九个工具继续可用：

| 用途 | 工具 |
| --- | --- |
| 一句话入口 | `handoff` |
| 连接与发现 | `handoff_connection`、`handoff_devices` |
| 队列与状态 | `handoff_inbox`、`handoff_outbox`、`handoff_status` |
| 发送与接收 | `handoff_send`、`handoff_receive` |
| 回执与取消 | `handoff_receipt`、`handoff_cancel` |

接收校验自动回报 `verified`；Agent 按实际动作记录 `accepted → started → completed`。心跳和通知均不能单独证明模型已接受或完成任务。

## 部署中转服务

Relay 要求 Node.js **24.22.1+（24.x）**，使用内置 SQLite，无需安装 npm 依赖。在仓库根目录运行：

```sh
cd agent-handoff-relay
node bin/relay.mjs init --data ./data
node bin/relay.mjs serve --data ./data
```

默认监听 `127.0.0.1:17860`。正式部署请使用 [Ubuntu 部署指南](agent-handoff-relay/docs/DEPLOY-UBUNTU.md)，配置 HTTPS 和独立认证的管理界面，再从后台登记设备、下载设备凭证。后台安装包下载是可选部署项，需要管理员另行构建并放置 tgz。

## 使用边界

- 交接内容是任务上下文和实际文件；插件不读取或改写宿主原生聊天数据库。需要完整原始对话时，应提供真实导出文件。
- 心跳说明桥接进程已连接；回执是接收端的声明，均不能单独证明模型已完成任务。
- 接收内容属于外部任务数据，需按宿主正常权限与审批处理。插件不自动执行收到的脚本。
- 文件限于所配置工作目录，拒绝路径穿越、符号链接、私钥等敏感路径。单次最多 2000 个文件、1 GiB 原始文件数据，还受服务端配额限制。
- 已验证 macOS arm64、Ubuntu x86_64 的加密文件交接；Windows 原生运行、各宿主 GUI 的完整模型接管尚未验收。详见 [验证范围](agent-handoff-relay/docs/VALIDATION.md)。

## 文档

| 你要做的事 | 文档 |
| --- | --- |
| 让其他 Agent 安装 | **[INSTALL.md](INSTALL.md)** |
| 调整客户端、使用 CLI、多 profile | [客户端说明](agent-handoff-connect/README.md) |
| 了解中转服务 | [Relay README](agent-handoff-relay/README.md) |
| 部署服务器 | [Ubuntu 部署](agent-handoff-relay/docs/DEPLOY-UBUNTU.md) |
| 使用管理后台 | [管理说明](agent-handoff-relay/docs/ADMIN.md) |
| 对接传输接口 | [API](agent-handoff-relay/docs/API.md) · [客户端协议](agent-handoff-relay/docs/CLIENTS.md) |
| 了解已测范围与限制 | [验证记录](agent-handoff-relay/docs/VALIDATION.md) |

## 开发与测试

运行集成测试需要 Node.js 24、age 和 age-keygen。以下命令从仓库根目录开始：

```sh
cd agent-handoff-relay
AGE_BIN=/absolute/path/to/age node --test test/*.test.mjs
cd ../agent-handoff-connect
npm ci
npm run build
TEST_AGE_BIN=/absolute/path/to/age npm test
```

age-keygen 默认与 age 同目录，客户端测试也支持 `TEST_AGE_KEYGEN`。Relay 未设置 `AGE_BIN` 时会跳过真实 age 加密用例；客户端测试需要 age。提交问题时请附运行系统、Node.js 版本、脱敏错误和复现步骤。

项目代码采用 [MIT 许可证](LICENSE)。管理界面的 IBM Plex 字体许可证见 [字体许可](agent-handoff-relay/web/fonts/LICENSE.txt)；字体以 `.ttf.b64` 保存，由服务器启动时解码提供。

<details>
<summary>README 结构参考</summary>

参考 [Serena](https://github.com/oraios/serena)、[mcp-remote](https://github.com/geelen/mcp-remote) 和 [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 的用途说明、快速开始、配置与文档导航方式。这里的功能、命令和验证范围均以本仓库实现为准。

</details>
