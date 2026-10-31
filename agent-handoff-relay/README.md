# Agent Handoff Relay 0.3.0

可运行的加密交接包中转服务，面向一台 Ubuntu 24.04 服务器和多台 Windows/Linux/macOS 客户端。

本版已经实现传输层：设备独立认证、持久队列、分块上传、断点恢复、密文摘要校验、私有收件箱、范围下载、回执、取消、过期清理和管理 CLI。它没有读取或改写任何 Agent 的原生会话库。

0.2.0 增加独立登录的 Web 管理界面、设备凭证管理、Agent 身份心跳、传输流向图、分片进度、流量与回执事件。配置和统计口径见 [后台说明](docs/ADMIN.md)。

0.3.0 增加设备公钥目录，与相邻的 [MCP 插件安装器](../agent-handoff-connect/README.md) 配合完成上下文打包、加密、接收和清单校验。后台可按需分发安装包。

## 现在能做什么

- A→B、B→A 及任意已登记设备之间发送 `.age` 加密文件。
- 一个文件可以包含任务说明、会话转录及实际产出；来源端先打包再加密。
- 每块最多 8MiB；服务端确认前先落盘。重跑相同 id 的发送命令可恢复上传。
- 下载 `.part` 支持续传（包括尚未写入字节的空文件）；完成后校验密文大小与 SHA-256，拒绝覆盖不同的现有输出。
- 每设备 256-bit 随机 Bearer 凭证，仅以 SHA-256 摘要存数据库；撤销/轮换即时影响新请求。
- 收件箱按发布次序分页，不会因为早创建的包上传较慢而被游标跳过。
- 回执状态不能倒退，重复请求使用稳定 request id 去重。
- 服务只监听 `127.0.0.1`，通过 Caddy 对外提供 HTTPS。

## 本版的边界

- 多端本地 MCP 插件见相邻目录；后台同步与原生会话数据库迁移不在实现范围内。
- 接管回执是**接收设备声明**，不是中转已经观察到模型执行。
- 尚未实现 task/branch 所有权 CAS、fencing、端到端发送者签名和原生会话转换。
- 服务不解密，检查的是二进制 age 文件头和密文摘要，不能证明接收者能解密或正文内部清单完整。
- 身份认证凭证与 age 私钥是两件事；服务提供认证后的公钥发现；age 私钥由各设备的插件保存。
- 服务端不解包或执行收到的文件；插件在接收端解密、验证并写入独立收件目录。
- 默认 10GiB 逻辑配额、单包 1GiB、30 天过期；尚未压测，不做吞吐量或高可用承诺。
- 日志不记录 Authorization、凭证、正文或文件内容；服务器仍可见设备标识、密文大小、摘要与收发时间。
- 元数据与回执在密文过期后仍保留，本版尚无元数据归档/清理工具。

## 运行环境

Node.js **24.22.1 或更新的 24.x**，不需要 npm install；只使用 Node 内置模块。服务器安装器固定隔离安装 Node 24.22.2，不替换现有系统 Node.js。

首版服务端目标为 Ubuntu 24.04。跨系统命令行客户端也要求 Node 24.x。测试报告中的已执行平台和未验证平台分开说明。

## 具体部署与使用

- [Ubuntu 24.04 部署步骤](docs/DEPLOY-UBUNTU.md)
- [三端客户端与真实加密交接](docs/CLIENTS.md)
- [HTTP API 与错误处理](docs/API.md)
- [实现和验证范围](docs/VALIDATION.md)

## 快速本机开发

```sh
node --test test/*.test.mjs
node bin/relay.mjs init --data ./data
node bin/relay.mjs serve --data ./data
```

不要将本地 `data/`、设备凭证或 age 私钥打进代码包。

管理命令：

```sh
node bin/relay.mjs device add --data ./data --id win-office --name win-office --url https://relay.example.com --out ./private/win-office.json
node bin/relay.mjs stats --data ./data
node bin/relay.mjs device revoke --data ./data --id win-office
```

凭证仅写到新文件，命令输出不打印 token。轮换用 `device rotate`，参数与 add 相同但不需要 name，输出路径必须是新文件。

`backup --data <目录> --out <新路径>` 使用 SQLite 在线备份 API，**只备份数据库**。完整包仓库备份请使用部署说明中的停服备份脚本。

## 验证进度

中转服务共 29 项测试，插件共 10 项集成测试。macOS arm64 和 Ubuntu x86_64 已完成测试及真实双向交接。当前公开副本的验证结果、未验证平台和边界见 [验证范围](docs/VALIDATION.md)。

## 测试

```sh
node --test test/*.test.mjs
```

测试监听本机随机端口，真实 HTTP 调用服务，并验证 CLI 子进程。若要运行真实 age 加密/解密用例，设置 `AGE_BIN` 为已安装 age 的绝对路径，且同目录下有 age-keygen：

```sh
AGE_BIN=/usr/bin/age node --test test/*.test.mjs
```

未设置 AGE_BIN 时，真实加密用例明确记为 skipped；其他传输用例使用合成文件头，不能用来声称验证了密码学实现。

## 文件说明

```text
bin/relay.mjs        服务与本机管理 CLI
bin/client.mjs       跨平台收发 CLI
src/store.mjs        SQLite 状态与持久化文件操作
src/server.mjs       HTTP API、上传锁和过期处理
src/client.mjs       流式收发、续传和本地验证
src/admin.mjs        管理员认证、会话与管理 API
src/monitor.mjs      心跳、传输进度与事件采集
web/                管理界面，无外部依赖
deploy/              Ubuntu 安装器、systemd、Caddy、备份
test/                HTTP 与 CLI 集成测试
```
