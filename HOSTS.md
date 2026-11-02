# 四个宿主怎么用

适用于客户端 **0.7.0** / Relay **0.5.0**。发送端说“总结当前会话并上传”；接收端说“查看远端会话”，再按标题选择继续。无需先指定设备。详见 [SESSIONS.md](SESSIONS.md)。下文的“接力到某设备”仍用于定向文件交接。

安装器新增了原生技能，不再只登记一组 MCP 工具。接力技能内置绑定本机配置的脚本；宿主有终端能力时，即使尚未重载 MCP，也能通过脚本收发。ChatGPT 普通聊天通过官方安全隧道接入 MCP。

## 先安装一次

从可信管理员取得 `agent-handoff-connect-0.7.0.tgz`、中转服务 URL，以及私有 CA（如需）。或按 [INSTALL.md](INSTALL.md) 从源码打包。

```sh
npx --yes --package ./agent-handoff-connect-0.7.0.tgz agent-handoff
```

向导会优先推荐本机已有的宿主。只选择实际使用的项，输入服务地址、工作目录和 CA；首次接入在管理网页核对配对码并批准；已有 profile 会复用原设备身份。安装成功会分别给出各宿主入口和重载方法。

| 宿主 | 安装选项 | 技能入口（默认 profile） | 路由 |
| --- | --- | --- | --- |
| DeepSeek Harness 桌面 / CLI | `dsh` | `/relay` | `deepseek.harness` |
| Hermes | `hermes` | `/relay` | `hermes` |
| Codex Linux / CLI | `codex` | `$relay` 或 `/skills` 选择“接力” | `openai.desktop` |
| ChatGPT 桌面本地工作区 | `chatgpt` | 技能列表“接力 · ChatGPT” / `@relay-chatgpt` | `chatgpt.desktop` |
| ChatGPT 普通聊天 | `chatgpt` + 安全隧道 | 选中 Agent Handoff MCP 后说“接力” | `chatgpt.desktop` |

旧 `openai` 参数仅作为 `codex` 的别名。为兼容已排队的 Codex 投递，保留 `openai.desktop` 路由；**ChatGPT 已独立为 `chatgpt.desktop`**。已有误发到 Codex 路由的任务需在 Codex 接收或重新投递，不能静默改收件人。

若使用 `--profile office`，技能入口相应变成 `/relay-office`、`$relay-office`、`@relay-chatgpt-office`，避免多套服务相互覆盖。

## DeepSeek Harness

默认合并 `~/.dsh/profiles/desktop/cordis.patch.yml`，使用官方 `@deepseek-ai/dsh-mcp-client`。技能安装在 `$DSH_HOME/skills/relay/`，默认 `~/.dsh/skills/relay/`。

重启所选 DSH profile，在 `/` 菜单选择 `relay`：

```text
/relay 接力到办公室电脑
```

接收端输入 `/relay`。也可直接说“接力”。若使用 CLI 的其他 profile，安装时加 `--dsh-profile NAME`，并启动该 profile。DSH 需要启用官方文件系统技能提供器和技能工具；自定义精简组合未加载技能时，可以使用 MCP 的 `handoff` 工具。

## Hermes

合并 `$HERMES_HOME/config.yaml` 的 `mcp_servers`，技能写入 `$HERMES_HOME/skills/relay/`，默认根目录 `~/.hermes`。

在 Hermes 输入 `/reload-mcp`，再输入 `/reload-skills`，之后：

```text
/relay 接力到办公室电脑
```

接收端输入 `/relay`。避免使用 `/handoff`：它是 Hermes 自带的命令，不属于本插件。

## Codex Linux

合并 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）的 MCP 条目，并在 `~/.agents/skills/relay/` 安装技能。重启 Codex 后：

```text
$relay 接力到办公室电脑
```

接收端输入 `$relay`。`/skills` 可查看接力技能。无图形桌面的 Linux 保留 MCP 日志提醒；不会声称出现了桌面弹窗。

## ChatGPT 桌面客户端

**本地工作区**：安装器把技能和脚本写入 `~/.agents/skills/relay-chatgpt/`，附带桌面 UI 元数据。刷新技能列表或重启，在有本地终端能力的工作区选择“接力 · ChatGPT”。技能脚本已经绑定本机身份和路由。若客户端未发现本地技能，可在其技能管理入口导入该目录；安装器输出的路径可用于定位。

**普通聊天**：它不能直接运行本机脚本，需要连接 MCP。0.7.0 提供 `chatgpt-connect`，通过 OpenAI 的 Secure MCP Tunnel 转发本机 stdio MCP，不开放新的公网端口。

首次连接只需完成一次账号设置：

1. 在 [OpenAI Platform 隧道设置](https://platform.openai.com/settings/organization/tunnels) 创建或复用隧道，并关联目标 ChatGPT 工作区。
2. 在本机安全设置环境变量 `CONTROL_PLANE_API_KEY`。运行时密钥需有该隧道的 Tunnels Read + Use 权限；不要把密钥发到聊天、写进命令参数或提交到仓库。
3. 执行下面的连接命令，将示例 ID 换成实际值：

```sh
npx --yes --package ./agent-handoff-connect-0.7.0.tgz agent-handoff chatgpt-connect \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef
```

首次会下载固定官方 `tunnel-client v0.0.19` 并核对预置 SHA-256，生成仅属于本插件的隧道 profile，运行 doctor 后进入前台连接。也可提供 `--tunnel-bin /absolute/path/to/tunnel-client`。失败会停止，不继续伪报已连接。

在 ChatGPT 的自定义 MCP 接入入口选择 **Tunnel** 和相同的 `tunnel_id`，完成账号要求的确认，并在聊天中选中该接入。界面名称可能随客户端版本不同。接入通过工作区的隧道访问控制授权；本地服务不额外暴露 HTTP 认证端点。

后续只需在已有环境变量的终端运行（沿用安装时的 `--profile`）：

```sh
npx --yes --package ./agent-handoff-connect-0.7.0.tgz agent-handoff chatgpt-connect
```

隧道 ID、程序路径会保存；**运行时密钥不保存**。保持该终端运行，退出后普通聊天的 MCP 连接会中断。ChatGPT 账号或工作区必须允许自定义 MCP 和关联隧道；单纯登录 ChatGPT 不等于具备这些权限。

## 收到交接后

插件先解密、校验文件，再由 Agent 阅读并继续用户授权的任务。技能负责记录实际接受、开始、完成回执；下载成功只记为 `verified`。多条待办会列出选择，不会擅自选最新一条。

MCP 连接时每 10 秒检查新交接并去重提醒；技能脚本单次调用时只进行本次收发和路由上报，不提供后台驻留提醒。通知不能唤醒已退出的宿主，也不能保证模型自动弹出确认窗口。macOS / Windows / Linux 桌面通知仍取决于宿主、桌面会话和系统权限。

## 升级与验证

使用 0.7.0 包、原 `--home` 和 `--profile` 重跑向导，选择最终要保留的**完整宿主列表**。旧设备凭证和 age 私钥会复用，不需要更新凭证。卸载会移除该 profile 的受管理 MCP 条目和技能文件；用户另外添加的文件、身份和任务文件保留。修改过的受管理文件会报冲突，不能静默覆盖。

配置成功、真实工具连通、模型接手是三件事。请在目标宿主实际执行“接力”验证；`doctor` 只检查配置、密钥和 Relay。0.5.0 已用四个独立路由的安装脚本完成真实加密文件收发、回执和隔离测试，并验证旧版升级。ChatGPT 官方二进制的下载校验、init 参数与 profile 生成已实测；账号隧道授权、四个宿主 GUI 的完整模型接管和 Windows 原生运行仍需目标环境验收。

官方接入依据（2026-11-02 核对）：

- [OpenAI：构建技能](https://learn.chatgpt.com/docs/build-skills)
- [OpenAI：Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI：连接和测试 MCP](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [DSH：文件系统技能](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md)
- [DSH：技能菜单](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-skill/README.md)
- [Hermes：技能](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)
- [Hermes：命令及名称冲突](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/slash-commands.md)
