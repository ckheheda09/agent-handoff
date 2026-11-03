# 安装 Agent Handoff（给用户和执行安装的 Agent）

客户端 **0.7.1**，首次配对要求 Relay **0.5.0**。首次安装不再要求管理员下载、传递设备凭证 JSON：客户端申请，管理员在网页核对配对码并批准，客户端自动保存凭证。

## 给执行安装的 Agent

用户让你安装本插件时，读取本文并在目标设备完成安装。只询问缺少的必要信息；保留其他 MCP、技能、配置及已有设备私钥。不要输出令牌、私钥或内部设备配对密钥，不把它们放入聊天、命令行参数或日志。可向用户展示短配对码。

需要这些信息：

| 参数 | 用途 |
| --- | --- |
| `AGENTS` | `dsh`、`hermes`、`codex`、`chatgpt`，可逗号多选 |
| `RELAY` | 管理员提供的传输 HTTPS origin，例如 `https://relay.example.com:17861` |
| `WORKSPACE` | 已存在、允许交接文件的本机绝对路径 |
| `PROFILE` | 本机中转配置名称，默认 `default` |
| `CA`（按需） | 私有 CA 的 PEM 证书绝对路径；公开 CA 可省略 |
| `DEVICE_NAME`（可选） | 网页显示名称；默认读取本机名称 |

不要要求用户提供设备凭证 JSON。用户明确要复用已有凭证时，使用文末兼容安装方式。首次配对只收集名称、系统、所选宿主和 age 公钥，不扫描其他文件或原生聊天数据库，不上传私钥。

## 1. 准备运行环境与安装包

需要 Node.js **22.18+**、npm/npx。缺少 age 时，安装器下载固定官方版本并校验预置 SHA-256，也可指定已有的 `--age-bin`、`--age-keygen`。客户端包尚未发布到 npm registry。

管理员已发布后台下载包时：

```sh
npx --yes --cafile /absolute/private/relay-ca.crt \
  --package=https://relay.example.com:17862/downloads/agent-handoff-connect-0.7.1.tgz \
  agent-handoff
```

也可下载可信 tgz 后运行：

```sh
npx --yes --package ./agent-handoff-connect-0.7.1.tgz agent-handoff
```

或从源码构建（需要 Git）：

```sh
git clone https://github.com/ckheheda09/agent-handoff.git
cd agent-handoff/agent-handoff-connect
npm ci
npm pack
npx --yes --package ./agent-handoff-connect-0.7.1.tgz agent-handoff
```

私有 CA 应由管理员通过可信渠道提供并核对指纹；保留 TLS 校验。`--cafile` 用于 npm 下载 tgz，安装向导的 CA 路径（或 setup 的 `--ca`）用于插件访问 Relay。自动配对不替代服务器证书信任。

## 2. 自动配对安装

交互式向导依次选择宿主、中转 URL、CA、工作目录，以及 DSH 原生 profile（默认 `desktop`）。随后安装窗口显示短配对码，例如 `ABCD-2345`。

保持安装进程运行，在本中转的管理网页“设备与 Agent → 待接入设备”找到申请。管理员核对设备、系统、宿主和**客户端显示的配对码**，点击“核对并允许”，勾选确认后允许接入。不要仅凭设备名称批准请求。

客户端自动领取并保存独立设备凭证，登记公钥、合并宿主配置；无需人工搬运 JSON。批准前不能读取设备目录、会话或文件。申请 10 分钟有效，可拒绝；拒绝或过期后重新运行安装会发起新申请。

执行安装的 Agent 可使用非交互参数；这里的 `--yes` 只省略本地提问，**不会绕过网页批准**：

```sh
npx --yes --package ./agent-handoff-connect-0.7.1.tgz agent-handoff setup --yes \
  --agents dsh \
  --relay https://relay.example.com:17861 \
  --ca /absolute/private/relay-ca.crt \
  --workspace /absolute/workspace \
  --profile office \
  --device-name '办公室电脑'
```

公开 CA 签发服务可省略 `--ca`。`--pairing-timeout 600` 设置本次等待时长（1–600 秒）；超时会保存申请和本地密钥，在申请有效期内用相同 home/profile/Relay 重跑可继续。网络中断可重试领取同一凭证，避免重复登记。安装失败时报告具体原因，不假报已连接。

Windows PowerShell（将路径换成真实本机路径）：

```powershell
npx --yes --package .\agent-handoff-connect-0.7.1.tgz agent-handoff setup --yes `
  --agents dsh `
  --relay https://relay.example.com:17861 `
  --ca "C:\Users\you\Private\relay-ca.crt" `
  --workspace "C:\Users\you\Projects" `
  --profile office
```

Windows 已有路径、ACL 和配置生成测试，原生桌面完整流程尚未实机验收。

## 3. 加载宿主并验证

| 宿主 | 默认配置 | 原生入口 / 重载 |
| --- | --- | --- |
| DeepSeek Harness | `~/.dsh/profiles/desktop/cordis.patch.yml` | 重启所选 DSH profile，在 `/` 菜单选择 `relay` |
| Hermes | `~/.hermes/config.yaml` | `/reload-mcp`、`/reload-skills`，然后 `/relay` |
| Codex Linux / CLI | `~/.codex/config.toml` | 重启 Codex；`$relay` 或 `/skills` |
| ChatGPT 桌面 | 本地接力技能 | 进入有终端权限的本地工作区，选择“接力 · ChatGPT” |

支持 `DSH_HOME`、`HERMES_HOME`、`CODEX_HOME`；DSH 其他原生 profile 用 `--dsh-profile NAME`。`--profile office` 指中转配置，与 DSH 原生 profile、Agent 路由 profile 分开。旧 `openai` 参数等同 `codex`。

配对成功只表示设备获准接入；配置写入也不等于宿主已加载 MCP。先运行：

```sh
npx --yes --package ./agent-handoff-connect-0.7.1.tgz agent-handoff doctor --profile office
```

再在宿主确认工具列表包含 `handoff_connection`、`handoff_publish_session`、`handoff_sessions`、`handoff_resume_session`，调用 `handoff_connection` 验证实际连接。MCP 初始化后每 30 秒上报身份心跳；网页显示设备和 Agent。ChatGPT 普通聊天另需官方安全隧道，详见 [HOSTS.md](HOSTS.md)。

发送端说“总结当前会话并上传”，接收端说“查看远端会话”，按标题选择继续。定向文件交接仍可说“接力到办公室电脑”。完整说明见 [SESSIONS.md](SESSIONS.md)。

## 重新配置、升级与兼容凭证

旧设备用原 `--home`、`--profile` 和完整宿主列表重跑安装，自动复用现有令牌与 age 私钥，不重新配对、不覆盖无关 MCP。升级后重载宿主。

需要导入原有或轮换后的凭证时，显式增加：

```sh
npx --yes --package ./agent-handoff-connect-0.7.1.tgz agent-handoff setup --yes \
  --agents dsh \
  --credentials /absolute/private/device.json \
  --workspace /absolute/workspace \
  --profile office
```

Relay 0.5.0 以前不支持自动配对，应先升级中转或用兼容凭证导入。旧客户端继续使用原有 API。设备删除后旧身份不可恢复，重新接入使用新 `--profile` 发起新设备申请。

不同中转使用不同 profile；不要把本机令牌或 age 私钥复制给其他设备。自动领取的凭证保存在插件私有目录的 `credentials/`，待接入密钥在 `enrollments/`，领取成功后清理。原有配置和 age 私钥仍需妥善备份；私钥丢失无法解密旧会话。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 看不到接入申请 | 核对 Relay 地址与管理网页属于同一中转，刷新“设备与 Agent” |
| 配对码过期 / 被拒绝 | 在目标设备重跑原安装命令，在网页核对新的码 |
| 等待批准超时 | 保留 home/profile/Relay，重跑；10 分钟有效期内复用同一申请 |
| `pairing_rate_limit` / `pairing_capacity` | 等待旧请求过期，避免并行重复发起；后台拒绝陌生申请 |
| `unauthorized` | 设备可能已删除或轮换；导入新凭证，或用新 profile 重新配对 |
| 证书错误 | 核对 URL 与 CA；下载包用 `--cafile`，插件连接用 `--ca` |
| 已批准但没有 Agent 心跳 | 查看安装进程是否完成，再按宿主提示重载 MCP |
| 连接报告成功但聊天没有工具 | 配置写入与宿主加载分开验证，参考 HOSTS.md |

执行安装的 Agent 最终应分别报告：设备是否配对、配置是否完成、doctor 是否通过、宿主 MCP 是否实际连通。只有实际验证过的步骤才能标记完成。
