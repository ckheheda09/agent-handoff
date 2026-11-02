# Agent Handoff Connect 0.5.0

多端 Agent 交接插件与交互式安装器。提供宿主原生技能、本地 MCP（stdio）及 ChatGPT 官方安全隧道接入；可选择 DeepSeek Harness、Hermes、ChatGPT 桌面客户端、Codex Linux，连接任意兼容的 Agent Handoff Relay。

## 通过 npx 安装

需要 Node.js 22.18+（含 npm/npx）。当前交付的是独立 npm 安装包，尚未发布到 npm registry；以下包地址可直接用于 npx。

管理员已在后台发布安装包、且你已有对应 CA 证书时，在目标设备的终端运行：

```sh
npx --yes --cafile /path/to/relay-ca.crt --package=https://relay.example.com:17862/downloads/agent-handoff-connect-0.5.0.tgz agent-handoff
```

Windows PowerShell 示例（替换为本机实际路径）：

```powershell
npx --yes --cafile "C:\Users\you\Downloads\relay-ca.crt" --package=https://relay.example.com:17862/downloads/agent-handoff-connect-0.5.0.tgz agent-handoff
```

如果使用已下载的 tgz，可完全避免 npm 下载时的证书配置：

```sh
npx --yes --package ./agent-handoff-connect-0.5.0.tgz agent-handoff
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

安装完成后按 HOSTS.md 加载技能。Hermes 可 `/reload-mcp` 后 `/reload-skills`，Codex 重启会话。对 Agent 说：

> 检查接力插件是否已连接。

MCP 客户端完成初始化后才每 30 秒上报一次身份心跳；后台会显示设备、Agent 和真实上传/下载/回执事件。桥接进程连接不代表模型接受了任务。

## 指定服务与多套配置

非交互式安装示例：

```sh
npx --yes --package ./agent-handoff-connect-0.5.0.tgz agent-handoff setup --yes \
  --agents dsh,hermes,codex,chatgpt \
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
npx --yes --package ./agent-handoff-connect-0.5.0.tgz agent-handoff setup \
  --relay http://127.0.0.1:17860 --allow-loopback-http
```

HTTP 只允许显式开启的回环地址，不允许公网明文 HTTP。TLS 校验始终开启，重定向不转发设备令牌。

## 宿主原生接入

| 选择项 | 快捷入口 | 后台 adapter_id |
| --- | --- | --- |
| `dsh`：DeepSeek Harness | `/relay` | `deepseek.harness` |
| `hermes`：Hermes | `/relay`（避开宿主自带 `/handoff`） | `hermes` |
| `codex`：Codex Linux / CLI | `$relay` 或 `/skills` | `openai.desktop` |
| `chatgpt`：ChatGPT 桌面 | 本地技能“接力 · ChatGPT”；普通聊天使用安全隧道 | `chatgpt.desktop` |

技能内置脚本，绑定中转 profile、设备配置和宿主路由；有本地终端时不依赖 MCP 已重载。输入摘要通过 stdin 传入，用户不必编写 JSON。脚本每次调用只上报本次活动，持续通知仍需 MCP 连接。

ChatGPT 普通聊天运行 `agent-handoff chatgpt-connect --tunnel-id tunnel_...`，需要 OpenAI 的关联隧道和本机 `CONTROL_PLANE_API_KEY`，不能靠修改 Codex 配置连接。首次自动下载并校验固定官方 tunnel-client，后续复用 ID；密钥不保存。账号未关联或 doctor 失败会停止。

完整路径、重载、账号步骤和验收范围见 **[HOSTS.md](https://github.com/ckheheda09/agent-handoff/blob/main/HOSTS.md)**；安装说明见 **[INSTALL.md](https://github.com/ckheheda09/agent-handoff/blob/main/INSTALL.md)**。

旧 `openai` 是 `codex` 的别名。支持 `DSH_HOME`、`HERMES_HOME`、`CODEX_HOME`，以及 `--dsh-config FILE`、`--hermes-config FILE`、`--codex-config FILE`（旧 `--openai-config` 兼容）。`--agent-profile NAME` 设置中转路由 profile_id。自定义宿主根目录测试可用 `--agent-home DIR`。

配置和技能修改前创建私有备份，保留无关配置、注释和用户添加的其他文件。已管理文件被用户修改时会停止，防止覆盖。多 profile 分别生成 `relay-<profile>` 技能。

## 一句话接力

所有支持的 Agent 都使用同一套说法，无需记工具名或填写路由参数：

- 发送端：**“接力到办公室电脑。”**（用后台显示名称或设备 ID；也可说“接力到办公室电脑的 Hermes”。）
- 接收端：**“接力。”** 或 **“接收接力。”**

由发送端 Agent 整理当前会话的真实背景、已完成工作、决定、约束和下一步，选择必要文件；插件自动匹配设备名称并发现目标 Agent。接收端只有一条待办时直接下载、解密和校验，Agent 读取后继续用户授权的工作。多台设备同名、多个可用 Agent 或多条待办时，只需选择一次，不会擅自发送或领取。

两端都需先安装插件、使用各自设备凭证连接同一个 Relay。接收设备需要已有 age 公钥；Agent 关闭时仍可排队投递到已知路由，但不会自动启动模型。

### 收到新交接的提示

MCP 连接期间，每 10 秒检查新交接。默认请求系统提醒：“收到新交接，在 Agent 中说‘接力’即可领取”，同时发送 MCP 日志通知。按设备、Agent 路由过滤，多个连接共享通知记录，重启后不会重复提醒同一交接。提醒不会下载、解密或自动执行任务，也不展示会话正文。

macOS 使用系统通知；Windows 使用有超时的提示框；Linux 桌面使用 `notify-send`。实际显示取决于桌面会话、通知权限和勿扰设置，系统接受通知请求不等于屏幕一定显示。Windows/Linux 原生桌面弹窗尚未实机验收；无图形桌面时保留 MCP 日志通知。宿主退出或电脑离线时不检查，重新连接后检查未提示的待办。

安装/重配加 `--notifications off` 可关闭系统提醒；`--notifications system` 开启。使用原 profile 重配并重启宿主，不需要更新设备凭证。`agent-handoff notify-test --profile office` 请求一条不含会话内容的系统测试提醒；`handoff_connection` 返回通知检查状态。MCP 日志是否显示在聊天窗口由宿主决定；本版不提供点击通知后自动打开会话、自动接受任务或唤醒已退出宿主。

### 工具与数据

首选统一工具 `handoff`：有 `target` 时发送，没有时接收；Agent 自动填写参数。原有九个工具继续可用，便于诊断和控制：`handoff_connection`、`handoff_devices`、`handoff_inbox`、`handoff_outbox`、`handoff_status`、`handoff_send`、`handoff_receive`、`handoff_receipt`、`handoff_cancel`。

文件包包含 `manifest.json`、`HANDOFF.md` 和 `files/` 中的实际文件，发送前用接收设备的 age 公钥加密。接收端核对密文与文件 SHA-256、检查归档路径后写入 `<workspace>/.agent-handoff/inbox/<handoff-id>/`。

校验后只自动回报 `verified`；Agent 根据实际动作记录 `accepted → started → completed`。任务上下文由发送端 Agent 从可见会话整理；插件不自动读取或改写宿主原生聊天数据库。完整原始对话需提供真实导出文件。接收内容是外部任务数据，仍使用宿主正常审批。

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

失败后保留相同 `id`、文本和文件重试，可复用相同密文并继续上传；内容变更时使用新 ID。CLI 传入 `--agent` 时限定对应路由；原生技能脚本固定携带该参数。不传时可手动接收本设备的任务。收件箱和发件箱 CLI 默认返回前 100 条；MCP 支持 `after` 分页游标。

## 私有存储与边界

默认目录为 macOS/Linux 的 `~/.config/agent-handoff`，Windows 的 `%LOCALAPPDATA%/AgentHandoff`；可用 `--home DIR` 或 `AGENT_HANDOFF_HOME` 修改。令牌只保存在私有配置文件，绝不写入 Agent 配置参数或上传给其他设备。Unix 私有目录 0700、文件 0600；Windows 使用当前用户 ACL。

目录内保存设备私钥、profiles、固定运行程序、证书和加密重试缓存。请备份私钥：重新安装会复用；若私钥丢失，旧密文无法解密。同一设备公钥不能由安装器静默替换，需在后台登记一个新的设备身份。

只读取配置工作目录内明确指定的文件或目录；拒绝路径穿越、符号链接、大小写冲突，以及 `.env`、`.ssh`、`.aws`、Agent 私有配置、私钥等路径。选整个目录时跳过这些项目。单次最多 2000 个文件、1 GiB 原始文件数据，同时受服务端密文大小和存储配额限制。含大量文件或接近上限的包可能需要拆分。

卸载移除当前 profile 的受管理 MCP 条目与技能文件，保留身份、凭证、缓存与接收文件。崩溃留下的锁目录会明确报出路径，确认没有插件操作后再手动移除该锁。

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
