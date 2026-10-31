# Agent Handoff

通过自建中转服务，在多台设备的 Agent 之间交接任务上下文和实际文件。仓库包含加密中转服务、Web 管理界面和本地 MCP 插件安装器，当前版本为 **0.3.0**。

- **[中转服务与管理界面](agent-handoff-relay/README.md)**：设备登记、独立凭证、持久队列、断点续传、Agent 心跳、数据流和回执。
- **[多端 MCP 插件](agent-handoff-connect/README.md)**：交互式选择 DeepSeek Harness、Hermes、ChatGPT Desktop / Codex，配置自己的中转地址、凭证、CA 和工作目录。
- 文件在发送端用接收设备的 age 公钥加密，接收端解密并校验文件清单。中转仅保存密文和投递元数据。

这是任务与文件交接；不修改宿主的原生聊天数据库。当前 MCP 接入方式为本地 **stdio**，中转提供 HTTP 传输 API。

## 本地运行

中转服务要求 Node.js **24.22.1+（24.x）**，不需要安装 npm 依赖：

```sh
cd agent-handoff-relay
node bin/relay.mjs init --data ./data
node bin/relay.mjs serve --data ./data
```

默认只监听 `127.0.0.1:17860`。正式部署与管理界面配置见 [Ubuntu 部署说明](agent-handoff-relay/docs/DEPLOY-UBUNTU.md) 和 [管理后台说明](agent-handoff-relay/docs/ADMIN.md)。

## 构建 npx 安装包

客户端运行要求 Node.js 22.18+；在本仓库运行集成测试需 Node.js 24，并安装 age 与 age-keygen。

```sh
cd agent-handoff-connect
npm ci
npm run build
npm pack
npx --yes --package ./agent-handoff-connect-0.3.0.tgz agent-handoff
```

安装向导会选择 Agent、读取设备凭证，并询问中转服务 URL、CA 和工作目录。设备凭证由中转服务管理员生成。当前尚未发布到 npm registry，构建后的 tgz 可自行分发，或放到管理后台的可选下载目录。

## 测试

```sh
cd agent-handoff-relay
AGE_BIN=/absolute/path/to/age node --test test/*.test.mjs
cd ../agent-handoff-connect
npm ci
npm run build
TEST_AGE_BIN=/absolute/path/to/age npm test
```

age-keygen 默认与 age 同目录；插件也支持 `TEST_AGE_KEYGEN`。不设置 `AGE_BIN` 时，中转测试会明确跳过真实 age 加密用例。插件测试需要 age。

已完成 macOS arm64 和 Ubuntu x86_64 的集成测试及双向加密文件交接；Windows 原生运行和各宿主 GUI 的完整模型接管尚未验收，见 [验证范围](agent-handoff-relay/docs/VALIDATION.md)。

## 代码与数据

仓库不包含设备令牌、管理员密码、age 私钥、运行数据库、实际服务器 CA 或安装包。请把运行数据与公开源码分开保管。

管理界面的 IBM Plex 字体按原字节以 `.ttf.b64` 保存，由服务启动时解码为字体响应；许可证保留在 `agent-handoff-relay/web/fonts/LICENSE.txt`。项目代码采用 [MIT 许可证](LICENSE)。
