# 定向交接文件

仅在用户明确指定接收设备，或明确要把文件交给某端时使用。一般的“上传当前会话”仍走共享库。

## 发送

调用 `handoff_devices` 查看已授权设备和 Agent 路由。`handoff` 统一入口支持按完整显示名称或精确设备 ID 选择，指定 `action: send`：

```json
{
  "action": "send",
  "target": "用户指定的完整设备名称或 ID",
  "title": "任务标题",
  "context": "由当前 Agent 整理的真实上下文",
  "next_steps": "待继续的工作",
  "files": []
}
```

有多个设备、同名设备或多个 Agent 路由时，按返回的 `choose_device` / `choose_agent` 候选让用户选择；不凭显示顺序猜目标。需要时填写 `agent` 和 `agent_profile`。只有精确接口可用时，`handoff_send` 使用目录返回的 `to`、`adapter`、`agent_profile`。

文件限于已配置工作目录内、任务需要且用户允许传递的相对路径。无文件时传空数组，不扫描整个主目录或原生聊天数据库，不带凭证与私钥。成功上传只说明投递成功，不表示对方已接手。

## 接收与回执

按用户选择的定向任务编号调用 `handoff_receive({id})` 或 `handoff({action: "receive", id})`。校验成功后读取摘要及必要文件，核实接收路径；不覆盖正在使用的工作文件来模拟恢复。

只有定向任务使用 `handoff_receipt({id, state, code})`，其中 `code` 是简短机器可读原因（字母、数字、下划线、点或连字符）。实际接受后记 `accepted`，开始做时记 `started`，完成后才记 `completed`；失败或拒绝如实记 `failed` / `rejected`。重试同一次回执沿用相同 `request_id`。

下载或 `verified` 不等于模型接受；心跳不等于任务开始。通知能否弹窗取决于宿主和桌面权限，不保证自动唤醒模型或弹出确认。共享会话的 resume 不走本文件的定向回执流程。
