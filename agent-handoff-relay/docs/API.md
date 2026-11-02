# HTTP API 0.5.0

正式入口为 HTTPS origin，无 URL 前缀。除 `/healthz` 和下述首次配对端点外，每个请求携带 `Authorization: Bearer <设备token>`。传输入口提供认证后的设备公钥目录；设备登记与管理走独立管理端口，见 ADMIN.md。响应设置 `Cache-Control: no-store`，无 CORS。

时间为 Unix 毫秒；大小、offset、cursor 均为十进制非负整数。JSON 请求要求 `Content-Type: application/json` 和 Content-Length，不接受分块传输编码；JSON 请求体最多 16KiB。

## 路由

| 方法 | 路径 | 权限和作用 |
|---|---|---|
| GET | `/healthz` | 无认证，返回 `{status:"ok",version:"0.5.0"}` |
| GET | `/v1/me` | 返回本设备 id、max_chunk_bytes 和 max_payload_bytes |
| POST | `/v1/handoffs` | 创建或幂等取得本设备发送的投递 |
| GET | `/v1/inbox?after=0&limit=100` | 本设备作为接收者的已发布包，含取消/过期后的元数据 |
| GET | `/v1/outbox?after=0&limit=100` | 本设备发送的包，含尚在上传和终止的包 |
| GET | `/v1/handoffs/{id}` | 发送者或接收者获取状态和 receipts |
| PATCH | `/v1/handoffs/{id}/payload` | 仅发送者追加密文块 |
| POST | `/v1/handoffs/{id}/commit` | 仅发送者校验并发布，JSON body 为 `{}` |
| GET | `/v1/handoffs/{id}/payload` | 发送者或接收者下载 ready 包 |
| POST | `/v1/handoffs/{id}/receipts` | 仅接收者提交状态回执 |
| DELETE | `/v1/handoffs/{id}` | 仅发送者取消；被接管后不可取消，rejected/failed 时允许 |

无关设备读取其他投递时返回 404，不暴露其是否存在。已删除或撤销设备的新请求返回 401。已经开始发送的下载无法收回。

## 创建与上传

```json
{
  "id": "report-20261030-01",
  "recipient": "mac-home",
  "size": 123456,
  "sha256": "替换为完整密文的64位小写十六进制SHA256",
  "payload_format": "age-v1",
  "adapter_id": "generic",
  "profile_id": "default"
}
```

必填 id、recipient、size、sha256、payload_format；adapter_id/profile_id 默认 generic/default。不允许未知字段，因此不要把标题、会话正文或文件名放进外层 metadata。真实内容放在加密包内。

- id、recipient：`[A-Za-z0-9][A-Za-z0-9_-]{0,79}`。
- adapter_id、profile_id：允许额外的点，最多 80 字符。
- size 至少为 age 文件头的 22 字节，默认不超过 1GiB；不接受 ASCII armor。
- 新建返回 201，完全相同的重复请求返回 200；同一 id 的字段不同返回 409。id 不因取消/过期而释放。
- 在事务中按声明 size 预留配额。默认总计 10GiB、每设备最多 20 个 uploading 包；ready 包仍占配额。

PATCH 请求：

```text
Content-Type: application/octet-stream
Content-Length: <本块字节数>
Upload-Offset: <当前已确认offset>
```

本块必须非空且不超过 8MiB，不能超过声明 size。成功返回 `{"id":"...","offset":新的累计字节数}`。只有文件 fsync 后才提交 offset。offset 不符返回 409，调用 GET 获取当前状态再续传；不要盲目重复 PATCH。上传和 commit 各最多同时 2 个请求，超过时返回 429。

全部上传后 POST commit。服务读取二进制 age-v1 文件头，流式计算完整密文 SHA-256，成功后发布到收件箱；commit 可重复。服务不解密，也不证明收件人的私钥匹配或内部文件齐全。

## 状态与分页

外部 handoff 对象含 id、sender、recipient、adapter_id、profile_id、size、sha256、offset、status、receipt_state、created_at、ready_at、expires_at、payload_format，以及：

```json
{"receipt_evidence":"recipient_device_reported"}
```

status 为 uploading、ready、cancelled、expired。receipt_state 是另一条设备报告的状态；完成回执不删除密文。取消/过期会删除密文并释放配额，保留元数据。

列表响应：

```json
{"items":[],"next_cursor":0}
```

limit 为 1–100。items 含 cursor；后续以 next_cursor 作为 after。inbox 按 **commit 发布次序**，outbox 按创建次序。游标只发现新包，不能用于订阅旧包的回执或状态变化；旧包通过 GET 查询。未发布包不会出现在 inbox 中。

## 下载与续传

无 Range 时返回 200；支持单区间 `Range: bytes=<start>-<end>` 或 `bytes=<start>-`，返回 206。区间必须完全在文件长度内；不接受后缀或多区间，非法区间返回 416。

响应包括 Content-Length、X-Payload-Sha256、Accept-Ranges: bytes、Content-Disposition。206 额外带 Content-Range。客户端必须核对返回区间、大小及完整密文摘要，再把 `.part` 发布为最终文件。

## 回执

```json
{"request_id":"report-01-verified","state":"verified","code":""}
```

request_id 与投递 id 使用同一格式，在数据库中全局唯一。code 可省略；只允许最多 64 个字母、数字、下划线或连字符，不传异常全文或私人内容。

允许的状态转换：

```text
pending  → verified | rejected | failed
verified → accepted | rejected | failed
accepted → started | failed
started  → completed | failed
completed / rejected / failed → 终态
```

重复 request_id 且设备、包、state、code 全相同，返回之前的事件；字段不同返回 409。每次状态变化使用新 request_id。事件返回含 seq、request_id、handoff_id、device_id、state、code、created_at。

接管回执是设备声明，不是服务观察到的模型行为，也不具有 task/branch 独占锁语义。本版不提供 CAS、fencing 或分支合并。

## 错误和重试

业务错误返回 JSON `{"error":"错误码","request_id":"服务端追踪id"}`；服务端异常不返回堆栈或请求正文。HTTP 解析层错误可能是空的 400 响应。

| HTTP | 示例错误 | 处理 |
|---|---|---|
| 400 | invalid_json / invalid_identifier / unknown_field | 修正请求，不盲目重试 |
| 401 | unauthorized | 检查或重新交付设备凭证 |
| 403 | recipient_only | 只有接收者能写回执 |
| 404 | handoff_not_found / recipient_unavailable | 核对 id、权限和目标设备状态 |
| 409 | offset_conflict / idempotency_conflict / invalid_receipt_transition | 重新读取状态，按冲突原因处理 |
| 410 | handoff_expired / handoff_cancelled | 不可续传或下载，必要时以新 id 再发送 |
| 411 / 413 / 415 | content_length_required / request_too_large / json_required | 修正请求头、块大小或内容类型 |
| 416 | invalid_range | 重新获取文件大小并校正续传 offset |
| 422 | checksum_mismatch / age_header_required | 不发布；检查源文件或加密步骤 |
| 429 | upload_concurrency_limit / too_many_pending_uploads | 稍后退避重试，或处理遗留上传 |
| 507 | storage_quota_exceeded | 释放配额或经管理员调整容量 |

断线后的创建、commit、回执可用原 id/request_id 重试；PATCH 先查 offset。客户端默认普通请求 120 秒超时、单次下载 1 小时超时，失败后保留可续传进度；本版 CLI 不自动排队重试。


## 0.3.0 插件公钥目录

所有接口要求设备 Bearer token。`GET /v1/devices` 返回已激活设备的 ID、名称、age X25519 公钥及已上报心跳的 Agent 身份（adapter_id/profile_id）；不返回令牌或私钥。

`POST /v1/me/encryption-key` 请求体仅允许 `{"recipient":"age1..."}`。设备只能登记自己的公钥；服务验证 Bech32 校验和，重复登记同一密钥幂等，已有不同密钥返回 `409 encryption_key_conflict`。安装器不得静默替换旧密钥，以免已有密文失去解密能力。吊销的设备不出现在目录，原令牌访问立即被拒绝。

表 `device_encryption_keys` 是 schema-1 的附加扩展，启动时按需创建，原上传、下载、回执 API 保持兼容。旧版本回滚可保留该表；恢复数据使用一致性备份，不覆盖运行中的数据库。

## 0.4.0 共享会话库

以下接口均要求独立设备 Bearer 凭证。正文是本地多收件人 age 加密后的 JSON 摘要，服务端不解密。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/sessions` | 上传 `{id,title,source_agent,readers:[{device_id,recipient}],payload,sha256}`；payload 为二进制 age 的 base64，最大 3 MiB 密文。同 ID/同元数据及密文重试幂等，变化返回 409。 |
| GET | `/v1/sessions?after=0&limit=50` | 按当前设备上传时的授权范围列出有效会话元数据，返回 `items/next_cursor`；不返回正文。 |
| GET | `/v1/sessions/:id` | 读取单条元数据。 |
| GET | `/v1/sessions/:id/payload` | 元数据加加密 payload；未获该会话授权返回 404，撤销的凭证返回 401。 |
| POST | `/v1/sessions/:id/received` | 传空 JSON；按设备记录校验接收，幂等；不消耗或独占会话。 |

每份会话沿用服务的 TTL，与定向文件交接共用总配额。过期后回收密文，无法读取。新设备加入需要重新上传摘要；标题、来源和时间是服务端可见元数据。MCP `handoff_resume_session` 执行下载、解密与校验，之后才上报 received；这不是接受或完成任务的证明。

## 0.5.0 首次配对

- `POST /v1/pairings`：无需设备凭证。JSON 仅含 `{name,os,agents,recipient}`，agents 为 dsh/hermes/codex/chatgpt 列表，recipient 为校验通过的 age 公钥。返回 `{id,device_code,user_code,expires_at,interval_seconds,verification_uri}`。device_code 是秘密，只留在发起客户端；user_code 为供人工核对的短码。
- `POST /v1/pairings/:id/poll`：空 JSON，Authorization 为 `Bearer <device_code>`。未批准返回 pending；应按 interval_seconds 轮询，过快返回 slow_down。拒绝 403，过期 410，无效秘密 404。批准后返回 `{status:"approved",credential:{credential_version,device_id,token}}`。
- `POST /admin/api/pairings/:id/approve` 或 `/reject`：管理端独立端口，必须持有管理员 Cookie、Origin 和 CSRF，JSON 为 `{user_code}`；短码单独不能批准或领取凭证。

请求最多每来源 10 分钟 10 次，同时最多 100 个有效未领取申请。请求 10 分钟有效。数据库只保留配对秘密和访问令牌的摘要，服务端根据请求秘密派生独立访问令牌，支持响应丢失后重试；轮换或删除优先于旧配对记录。批准前不创建设备权限；成功领取时原子地创建设备、登记公钥，之后按原认证方式工作。此为本项目的配对协议，并非 OAuth 服务。
