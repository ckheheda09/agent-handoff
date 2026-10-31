# Agent Handoff Connect 0.3.0

多端 Agent 交接插件与交互式安装器。支持 macOS、Linux、Windows 的本地 MCP（stdio）接入；可选择 DeepSeek Harness、Hermes、ChatGPT Desktop / Codex，连接任意兼容的 Agent Handoff Relay。

## 通过 npx 安装

需要 Node.js 22.18+（含 npm/npx）。当前交付的是独立 npm 安装包，尚未发布到 npm registry；以下包地址可直接用于 npx。

管理员已在后台发布安装包、且你已有对应 CA 证书时，在目标设备的终端运行：

```sh
npx --yes --cafile /path/to/relay-ca.crt --package=https://relay.example.com:17862/downloads/agent-handoff-connect-0.3.0.tgz agent-handoff
```

Windows PowerShell 示例（替换为本机实际路径）：

```powershell
npx --yes --cafile "C:\Users\you\Downloads\relay-ca.crt" --package=https://relay.example.com:17862/downloads/agent-handoff-connect-0.3.0.tgz agent-handoff
```

如果使用已下载的 tgz，可完全避免 npm 下载时的证书配置：

```sh
npx --yes --package ./agent-handoff-connect-0.3.0.tgz agent-handoff
```

使用私有 CA 时，请向服务管理员核对证书指纹；仓库不附带任何部署的 CA。

CA 只提供服务器身份信任，不含设备令牌。先从管理后台“登记设备”下载本设备的专用凭证 JSON。每台电脑使用独立设备身份；不要把私钥或相同设备凭证发给其他电脑。

向导依次询问：

1. Agent，可逗号多选。
2. 设备凭证 JSON 路径。
3. 中转服务 URL（可修改；示例为 `https://relay.example.com:17861`）。
4. 私有 CA 路径，或 `system` 使用系统信任。
5. 允许交接的工作目录。
6. 选择 DSH 时，询问原生配置名称，默认 `desktop`。

安装器会验证中转服务与凭证、生成并保存 age 身份、登记公钥，备份并合并 Agent 配置。缺少 age 时下载固定的官方 1.3.2 版本并核对预置 SHA-256。程序会保存到固定运行目录，Agent 启动时不再依赖 npx 缓存。

安装完成后重启 Agent（Hermes 也可 `/reload-mcp`；OpenAI 主机可在 MCP 设置中重载）。对 Agent 说：

> 调用 handoff_connection 检查连接，再调用 handoff_devices 和 handoff_inbox。

MCP 客户端完成初始化后才每 30 秒上报一次身份心跳；后台会显示设备、Agent 和真实上传/下载/回执事件。桥接进程连接不代表模型接受了任务。

## 指定服务与多套配置

非交互式安装示例：

```sh
npx --yes --package ./agent-handoff-connect-0.3.0.tgz agent-handoff setup --yes \
  --agents dsh,hermes,openai \
  --relay https://relay.example.com:443 \
  --credentials ./device.json \
  --ca ./relay-ca.crt \
  --workspace ./my-project \
  --profile office
```

公开 CA 签发的服务可省略 `--ca`。重新配置同一个 profile 时，可运行同样的 npx 命令加 `setup --profile office`，向导会读取原配置。`--ca system` 可清除已有私有 CA。

不同 profile 保存不同中转服务和工作目录，Agent 配置中的 MCP 服务器名称也分别生成。相同 profile 不允许更换设备 ID；请使用新 profile。更换服务地址时必须提供对应服务的设备凭证；错误令牌或公钥冲突会阻止安装。

SSH 隧道示例：

```sh
ssh -N -L 17860:127.0.0.1:17860 -p 22 root@relay.example.com
npx --yes --package ./agent-handoff-connect-0.3.0.tgz agent-handoff setup \
  --relay http://127.0.0.1:17860 --allow-loopback-http
```

HTTP 只允许显式开启的回环地址，不允许公网明文 HTTP。TLS 校验始终开启，重定向不转发设备令牌。

## 支持的 Agent 配置

| 选择项 | 默认配置文件 | 后台 adapter_id |
| --- | --- | --- |
| DeepSeek Harness 桌面 / CLI | `~/.dsh/profiles/desktop/cordis.patch.yml` | `deepseek.harness` |
| Hermes | `~/.hermes/config.yaml` 的 `mcp_servers` | `hermes` |
| ChatGPT Desktop / Codex | `~/.codex/config.toml` 的 `mcp_servers` | `openai.desktop` |

ChatGPT Desktop 与 Codex 在同一个 Codex host 共用配置，安装器合并为一个选项，避免重复启动。需要支持本地 MCP 的版本/主机。DSH 使用官方 `@deepseek-ai/dsh-mcp-client` 插件，CLI 用户通过 `--dsh-profile NAME` 指向自己的 DSH 配置。

支持 `DSH_HOME`、`HERMES_HOME`、`CODEX_HOME` 路径覆盖，也可明确指定 `--dsh-config FILE`、`--hermes-config FILE`、`--openai-config FILE`。`--agent-profile NAME` 设置中转路由中的 profile_id，默认 `default`；它与 DSH 原生配置名称是两个概念。

配置修改前生成 `.handoff-backup-*` 文件。无关配置及 YAML 注释会保留；DSH 的 `!!js` 标签不会执行。已有同名服务不是本安装器管理，或用户修改了已管理条目时，会停止并提示；不会覆盖冲突条目。

## 让 Agent 交接任务

发送示例：

> 列出可接收设备，把当前任务的目标、已完成工作、约束、关键决定、待办和实际产物 `reports/` 交给 win-office 的 Hermes。先说明发送内容，再调用 handoff_send。

接收端：

> 检查我的 handoff_inbox，接收指定交接。读取并验证上下文和产物，确认任务范围后接受，再继续工作。开始、完成时记录对应回执。

工具：`handoff_connection`、`handoff_devices`、`handoff_inbox`、`handoff_outbox`、`handoff_status`、`handoff_send`、`handoff_receive`、`handoff_receipt`、`handoff_cancel`。

文件包包含 `manifest.json`、`HANDOFF.md` 和 `files/` 中的实际文件，先在发送端打包并用接收设备的 age 公钥加密。中转服务仅保存密文和投递元数据。接收端下载断点续传后核对密文 SHA-256，解密、检查归档路径和逐文件 SHA-256，再写入：

```text
<workspace>/.agent-handoff/inbox/<handoff-id>/
```

只会自动回报 `verified`。`accepted → started → completed` 必须反映实际动作，后台可查看每一步回执。

这是任务上下文与真实文件的交接。插件不读取或改写封闭应用的原生聊天数据库；需要完整原始对话时，请明确提供真实的导出文件，Agent 不能自行补全未知历史。接收内容是外部任务数据，工具不会自动执行收到的脚本或指令，仍使用宿主正常审批。

## 手动 CLI

```sh
agent-handoff doctor --profile office
agent-handoff profiles
agent-handoff peers --profile office
agent-handoff inbox --profile office
agent-handoff send --profile office --input ./task.json
agent-handoff receive --profile office --id TASK_ID
agent-handoff receipt --profile office --id TASK_ID --state accepted --code reviewed
agent-handoff uninstall --profile office
```

上面的 `agent-handoff` 可替换成完整 npx 前缀；不要求全局安装。

`task.json` 示例：

```json
{
  "id": "task-report-001",
  "to": "win-office",
  "adapter": "hermes",
  "agent_profile": "default",
  "title": "继续报表工作",
  "context": "这里填写真实的任务背景、已有结论、约束和已完成工作。",
  "next_steps": "检查已附报表，补齐遗漏指标并给出结论。",
  "files": ["reports/"]
}
```

失败后保留相同 `id`、文本和文件重试，可复用相同密文并继续上传；内容变更时使用新 ID。CLI 手动接收不限定某个 Agent，但仍要求是目标设备。收件箱和发件箱 CLI 默认返回前 100 条；MCP 支持 `after` 分页游标。

## 私有存储与边界

默认目录为 macOS/Linux 的 `~/.config/agent-handoff`，Windows 的 `%LOCALAPPDATA%/AgentHandoff`；可用 `--home DIR` 或 `AGENT_HANDOFF_HOME` 修改。令牌只保存在私有配置文件，绝不写入 Agent 配置参数或上传给其他设备。Unix 私有目录 0700、文件 0600；Windows 使用当前用户 ACL。

目录内保存设备私钥、profiles、固定运行程序、证书和加密重试缓存。请备份私钥：重新安装会复用；若私钥丢失，旧密文无法解密。同一设备公钥不能由安装器静默替换，需在后台登记一个新的设备身份。

只读取配置工作目录内明确指定的文件或目录；拒绝路径穿越、符号链接、大小写冲突，以及 `.env`、`.ssh`、`.aws`、Agent 私有配置、私钥等路径。选整个目录时跳过这些项目。单次最多 2000 个文件、1 GiB 原始文件数据，同时受服务端密文大小和存储配额限制。含大量文件或接近上限的包可能需要拆分。

卸载只移除当前 profile 的 MCP 条目，保留身份、凭证、缓存与接收文件。崩溃留下的锁目录会明确报出路径，确认没有插件操作后再手动移除该锁。

## 从源码构建与测试

```sh
npm ci
npm run build
npm test
npm pack
```

插件运行时不依赖 SQLite；测试服务需要 Node.js 24，且需要 age/age-keygen。可用 `TEST_AGE_BIN`、`TEST_AGE_KEYGEN` 指定。发布包仅包含单文件 runtime、说明和许可证，不含开发依赖、凭证或测试数据。

对接依据（官方）：

- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md
- https://developers.openai.com/codex/mcp
- https://github.com/modelcontextprotocol/typescript-sdk
- https://github.com/FiloSottile/age/releases/tag/v1.3.2
