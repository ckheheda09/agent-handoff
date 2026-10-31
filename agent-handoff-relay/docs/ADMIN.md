# Web 管理界面（0.3.0）

管理入口使用独立 HTTPS 端口 17862，传输入口仍为 17861。管理服务只在 127.0.0.1:17863 监听，由 Caddy 提供 HTTPS。不要公开内部 HTTP 端口。

页面提供设备登记、凭证更新与撤销、Agent 心跳、交接流向图、上传/下载进度、60 分钟流量、交接详情和接收端回执。每 2 秒更新；后台页签降为每 10 秒更新。仅显示传输元数据，不解密内容。

设备最近 90 秒的认证请求显示为“近期活动”；设备登记本身不表示在线。Agent 只有主动上报身份心跳后，才显示为心跳 Agent；仅出现在投递目标中的 adapter/profile 标为“仅交接路由”。心跳也不代表模型已经接受或完成任务，任务状态以接收设备的回执为准。

在客户端使用 Node 24 和设备专属凭证上报：

```sh
export NODE_EXTRA_CA_CERTS=/path/to/relay-ca.crt
while true; do
  node bin/client.mjs heartbeat --credentials /private/device.json \
    --adapter my-agent --profile default --name '实际 Agent 名称' --version 1.0
  sleep 30
done
```

安装 [多端 MCP 插件](../../agent-handoff-connect/README.md) 后，MCP 客户端完成初始化即每 30 秒发送一次心跳，无需上述手动循环。后台不会远程扫描进程或读取明文会话。

流量从本版监控启用时开始记录，不补算旧包。上传统计已写入并确认的分片；下载统计服务端向响应流写入的字节，可能包含重试，不等于对端已接收或解密。事件最多保留 7 天、约 2 万条，交接列表显示最近 200 条。正在传输的进度在内存中，重启后从已确认的上传偏移继续。

管理员密码使用 scrypt 加盐哈希，仅保存在独立配置文件；会话 Cookie 使用 Secure、HttpOnly、SameSite=Strict，有效期 8 小时，重启失效。写操作同时校验 Origin 和 CSRF。新增/更新的设备凭证只在操作响应和下载文件中提供，不存入浏览器 localStorage。

启用配置：

```text
RELAY_ADMIN_CREDENTIAL_FILE=/etc/agent-handoff-relay/admin-auth.json
RELAY_ADMIN_ORIGIN=https://relay.example.com:17862
RELAY_PUBLIC_URL=https://relay.example.com:17861
RELAY_ADMIN_PORT=17863
```

密码重置：通过 SSH 在应用目录调用 `newAdminCredential()`，将 `credential` 写入上述文件（root:handoff-relay、0640），把 `password` 保存到管理员自己的私有文件，再重启 `agent-handoff-relay`。不要把原始密码写入日志或发布包。

## 设备命名与凭证更新

登记设备时可以填写显示名称。已有设备在“设备与 Agent → 已登记设备 → 改名”修改；设备标识保持固定，原凭证、加密密钥和已有交接继续有效，名称在下次刷新时同步到设备列表、网络图和 Agent 卡片。

“更新凭证”生成新的设备访问令牌并下载 JSON，旧令牌对新请求立即失效；已经开始发送的响应无法收回。它适用于凭证泄露、遗失或定期轮换，不用于设备改名、插件升级或发送会话。对已撤销设备更新凭证会重新启用该设备。

更新后，在原设备用同一个 profile 重新运行安装向导，明确指定新 JSON 的 `--credentials` 路径，然后重启宿主或重载 MCP。安装器会沿用已有的 age 私钥；仅替换最初下载的 JSON 文件不会更新已复制到插件配置中的令牌。

## 向另一台设备上的 Agent 交接

两端各自登记设备、安装 0.4.0 MCP 插件，并连接同一个 Relay。接收端需先登记 age 公钥。

- 发送端说：**“接力到办公室电脑。”**（用显示名称或设备 ID；需要时加“的 Hermes”。）
- 接收端说：**“接力。”**

发送端 Agent 负责整理真实会话上下文、待办和必要文件；统一 `handoff` 工具自动发现路由、发送或接收。多台设备同名、多个 Agent 或多条待办时，只需选择一个。网页“交接记录”查看传输与回执；可接收、已校验均不代表 Agent 已开始工作。

0.4.0 客户端在宿主 MCP 连接期间每 10 秒检查新交接，提供系统提醒与 MCP 日志通知，按设备和 Agent 路由去重。默认请求系统提醒，可用 setup 的 `--notifications off` 关闭。系统接受请求不保证屏幕显示，仍依赖桌面会话、通知权限和勿扰设置。宿主退出后不检查；通知不会自动接受任务、执行内容或启动模型。Windows/Linux 原生桌面弹窗尚未实机验收。

这是任务上下文与文件交接；完整原始对话先导出为文件，再随交接发送。安装与升级方式见 [安装指南](../../INSTALL.md)。
