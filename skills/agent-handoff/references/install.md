# 接入与 CLI

本技能按客户端 **0.7.1**、Relay **0.5.1** 的接口编写。技能负责指导 Agent；实际收发依赖本机客户端和已批准的设备身份。不要把另一台设备的令牌或 age 私钥复制过来。

## 配置已有设备

先发现宿主内可用的 MCP 工具；已经能调用 `handoff_connection` 时复用该连接，无需重新安装。终端上已有 `agent-handoff` 时可运行 `agent-handoff profiles`，列出不含令牌的连接信息；多套 profile 按用户选择使用。

本机配置默认位于 macOS/Linux 的 `~/.config/agent-handoff/profiles/`，Windows 的 `%LOCALAPPDATA%/AgentHandoff/profiles/`，可被 `AGENT_HANDOFF_HOME` 或 `--home` 覆盖。只在必要时读取其中的 runtime/node/路由字段，不把整份含令牌的 JSON 打印到聊天或日志。

## 首次安装

缺少以下信息时再问：目标宿主、中转服务的**传输 HTTPS origin**、可交接文件的本机工作目录；私有 CA 部署还需要管理员通过可信渠道提供 CA 证书。管理网页与传输接口可能使用不同端口，不从网页地址猜测 Relay API。

需要 Node.js 22.18+ 和 npm/npx。客户端尚未发布到 npm registry；不要假设 `npx agent-handoff-connect` 可用。可从管理员取得可信 `agent-handoff-connect-0.7.1.tgz`，运行：

```sh
npx --yes --package ./agent-handoff-connect-0.7.1.tgz agent-handoff
```

也可从项目源码构建；以下固定提交对应本技能的接口基线，更新版本应先检查其安装说明：

```sh
git clone https://github.com/ckheheda09/agent-handoff.git
cd agent-handoff
git checkout 70b0ebac2b6f0f47bf7c1d1b9cd4ddbcb0366791
cd agent-handoff-connect
npm ci
npm pack
npx --yes --package ./agent-handoff-connect-0.7.1.tgz agent-handoff
```

让向导选择目标宿主、Relay、CA 和工作目录。自动化安装可用下面的形式，替换示例值，`--agents` 只填已授权配置的宿主；公开 CA 可省略 `--ca`：

```sh
npx --yes --package ./agent-handoff-connect-0.7.1.tgz agent-handoff setup --yes \
  --agents codex \
  --relay https://relay.example.com:17861 \
  --ca /absolute/private/relay-ca.crt \
  --workspace /absolute/workspace \
  --profile office
```

本地生成独立 age 私钥和配对申请；管理员在该中转的管理网页核对客户端显示的短配对码后批准。保持安装进程运行，客户端自行领取并保存凭证。`--yes` 不能绕过批准。申请有效 10 分钟，网络中断或超时可在有效期内用同一 home/profile/Relay 重跑，不重复创建身份。

私有 CA 保留 TLS 校验。从 HTTPS URL 直接用 npx 下载 tgz 时，npm 的 `--cafile /trusted/relay-ca.crt` 用于**下载包**；客户端 setup 的 `--ca` 用于**连接 Relay**，两者分别设置。不要用关闭证书校验代替 CA。SSH 隧道只有在用户选择并已建立本机转发时才使用，localhost HTTP 需要显式 `--allow-loopback-http`。

## 宿主与配置范围

| 安装项 | Agent 路由 | 安装后验证 |
| --- | --- | --- |
| `codex` | `openai.desktop`（保留兼容名） | 重载宿主 MCP，检查工具并调用连接工具 |
| `dsh` | `deepseek.harness` | 重启所选 DSH profile，再检查工具 |
| `hermes` | `hermes` | `/reload-mcp`，需要技能入口时再 `/reload-skills` |
| `chatgpt` | `chatgpt.desktop` | 本地工作区技能与普通聊天 MCP 分别验证 |

仅调整用户要求的宿主，保留其他 MCP、技能、设备身份和私钥。**已有 profile 重跑 setup 会把 `--agents` 当作最终完整宿主列表，可能移除未列出的受管理条目。** 若只授权添加一个 MCP，先检查已有安装范围，采用定向配置合并；不要为新增 Codex 而改动 DSH 或 Hermes，也不要用 `--agents none` 重置已有宿主。

支持 stdio MCP 的其他宿主可以手动配置下面的结构。各字段换成当前机器的真实值，不硬编码其他设备的路径；路由使用该宿主的稳定标识和 profile：

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "/absolute/path/to/runtime/cli.mjs", "mcp",
    "--config", "/absolute/private/profiles/office.json",
    "--agent", "example.agent",
    "--agent-profile", "default"
  ]
}
```

安装结果返回 `runtime` 和 `config`；Node 路径按本机实际安装确定。全新通用宿主可用 `--agents none` 配对，再手动登记 MCP；只有确认是全新 profile 时才这样做。宿主不支持 stdio 时，需其支持的安全桥接方式；**Relay 传输 URL 本身不是 MCP URL**。

ChatGPT 普通聊天不能因为安装了本地技能就直接访问 stdio。项目提供 `chatgpt-connect` 桥接命令，但账号／工作区授权与实际 MCP 加载需另行验证。需要配置时读取项目 `HOSTS.md` 的 ChatGPT 章节，并核对当时的宿主官方接入说明；不要承诺普通聊天已经可用。

## 验证

```sh
npx --yes --package ./agent-handoff-connect-0.7.1.tgz agent-handoff doctor --profile office
```

然后在**目标宿主**确认三个共享会话工具可见，调用 `handoff_connection` 检查中转、profile、设备和路由。分别报告配对、配置写入、doctor、宿主 MCP 是否通过；doctor 通过不能代替宿主实际连通。无需向共享库发布测试会话来证明连接。

## CLI 备用入口

仅在当前环境没有可调用的对应 MCP 时使用。已有全局命令用 `agent-handoff`；否则用已安装配置中的 Node/runtime 绝对路径调用 `cli.mjs`，或前述可信 tgz 的 npx 入口。不要依赖本技能附带机器专属脚本。

```sh
agent-handoff profiles
agent-handoff sessions --profile office --agent example.agent
agent-handoff publish --profile office --agent example.agent --input -
agent-handoff resume --profile office --agent example.agent --id SESSION_ID
```

`publish --input -` 的 stdin 由 Agent 写入 JSON：`title`、`context`、`next_steps`，可附固定 `id`。用程序 stdin 或正确引用的文件传入，避免摘要中的反引号、美元符号被 shell 执行，也不要把正文放进命令参数。

按标题接收或列表翻页用统一入口 `agent-handoff handoff --profile office --agent example.agent --input -`，stdin 分别为 `{"action":"resume","title":"用户选中的完整标题"}` 或 `{"action":"sessions","after":123,"limit":20}`；`after` 必须来自实际返回的 `next_cursor`。CLI 与 MCP 遵循相同的选择、校验和共享会话规则。
