# 在 Ubuntu 24.04 上部署

以下面向新服务器；已有安装请先阅读升级与备份部分。示例采用 relay.example.com，请替换为自己的地址。

## 1. 获取源码并检查环境

```sh
git clone https://github.com/ckheheda09/agent-handoff.git
cd agent-handoff/agent-handoff-relay
df -h /
free -m
sudo ss -lntp
```

初始逻辑配额为 10GiB，建议保留约 20GB 空闲。保留已有网站与代理服务。

## 2. 首次安装中转

```sh
sudo apt update
sudo apt install -y curl xz-utils ca-certificates python3
sudo bash deploy/install-ubuntu.sh
```

安装器做以下工作：

- 确认 Ubuntu 24.04 与 x86_64/arm64 架构。
- 从 nodejs.org 下载 Node 24.22.2，按同源 HTTPS 提供的 SHASUMS256.txt 检查摘要。
- 安装到 `/opt/agent-handoff-relay/node`，不改系统现有 Node。
- 创建无登录权限的 `handoff-relay` 服务用户。
- 将源码复制到 `/opt/agent-handoff-relay/app`。
- 初始化 `/var/lib/agent-handoff-relay`，安装并启动 systemd 服务。
- 已有安装时拒绝覆盖；不更改 SSH、安全组或已有 Caddy 配置。

安装器也会检查已有数据目录和环境配置，避免把旧部署误当成首次安装。若上次安装中断，先核对报错和已生成的目录，再按升级/恢复方式处理；不要直接删除有数据的目录后重跑。

网络受限下载失败时，脚本在校验前停止。可通过允许的网络下载对应 Linux 架构的官方 Node 包和校验文件后手工安装；不要以关闭 HTTPS 校验处理下载失败。

检查应用本身：

```sh
sudo systemctl status agent-handoff-relay --no-pager
curl --fail http://127.0.0.1:17860/healthz
sudo journalctl -u agent-handoff-relay -n 30 --no-pager
```

健康接口正常应返回 `status: ok`。这仍只证明中转进程正常，不代表 Agent 已接入。

可用刚安装的 Node 在解压源码目录运行 Linux 集成测试：

```sh
/opt/agent-handoff-relay/node/bin/node --test test/*.test.mjs
```

## 3. 注册三台设备

凭证目录放服务用户私有目录。下面展示服务器本机管理 CLI；也可按 [管理后台说明](ADMIN.md) 启用独立认证的 HTTPS 管理界面：

```sh
sudo -u handoff-relay mkdir -p /var/lib/agent-handoff-relay/credentials
sudo -u handoff-relay /opt/agent-handoff-relay/node/bin/node /opt/agent-handoff-relay/app/bin/relay.mjs device add --data /var/lib/agent-handoff-relay --id win-office --name win-office --url https://relay.example.com --out /var/lib/agent-handoff-relay/credentials/win-office.json
sudo -u handoff-relay /opt/agent-handoff-relay/node/bin/node /opt/agent-handoff-relay/app/bin/relay.mjs device add --data /var/lib/agent-handoff-relay --id linux-lab --name linux-lab --url https://relay.example.com --out /var/lib/agent-handoff-relay/credentials/linux-lab.json
sudo -u handoff-relay /opt/agent-handoff-relay/node/bin/node /opt/agent-handoff-relay/app/bin/relay.mjs device add --data /var/lib/agent-handoff-relay --id mac-home --name mac-home --url https://relay.example.com --out /var/lib/agent-handoff-relay/credentials/mac-home.json
```

**执行前把三个 URL 都换成你的实际域名。** 若还没定域名，可先用 `https://relay.invalid` 注册，只通过下一节的 SSH 隧道测试，确定域名后再在设备凭证文件内修改 relay_url。

每个凭证文件含一个设备专用 token，通过自己的 SSH/SCP 管理通道安全交付给对应设备，不把这些文件放进发布包、Git 仓库或聊天记录。

服务用户目录不允许普通 SSH 用户读取。可以在服务器本机用 `sudo install -m 0600 -o <你的SSH用户> <来源凭证> <你的私有暂存路径>` 制作一份给该用户的副本，再从对应电脑 SCP 下载；下载完成后删除该临时副本。不要为了传文件把整个数据目录改为全员可读。

## 4. 尚无域名时，先用 SSH 隧道联调

每台电脑各开一个终端并保持连接：

```sh
ssh -N -L 17860:127.0.0.1:17860 你的SSH用户名@relay.example.com
```

客户端仍读取它自己的凭证文件，额外带上：

```sh
node bin/client.mjs whoami --credentials /你的路径/mac-home.json --tunnel-url http://127.0.0.1:17860
```

`--tunnel-url` 只接受本机回环 HTTP 地址，远程链路由 SSH 保护。它不是把公网中转改成明文 HTTP。每台电脑可选择不同本地端口，参数随之修改。

这条路径可先验证中转、凭证与文件传输，不依赖公网域名、Caddy 或为业务开放额外端口。它也不代表桌面 Agent 自动接入已完成。

## 5. 正式 HTTPS 入口

使用公网域名时，先完成云厂商要求的域名/备案接入并设置 A 记录。云安全组开放业务 443 和证书验证所需 80；17860 保持不对公网开放。SSH 只留给你的管理来源。

没有现有反向代理时，按 Caddy 官方 Ubuntu 稳定仓库安装：

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /tmp/caddy-stable.gpg.key
sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /tmp/caddy-stable.gpg.key
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /tmp/caddy-stable.list
sudo install -m 0644 /tmp/caddy-stable.list /etc/apt/sources.list.d/caddy-stable.list
sudo chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo apt update
sudo apt install -y caddy
```

把 `deploy/Caddyfile` 的站点块改为你的域名，合并到 `/etc/caddy/Caddyfile`。保留其他业务站点，先备份原文件：

```sh
sudo cp --no-clobber /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-agent-handoff
sudoedit /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

从各电脑测试：

```sh
curl --fail https://relay.你的域名/healthz
```

Windows PowerShell 使用 `curl.exe`。公网健康接口只返回程序版本与状态；设备认证仍由应用校验。

若已有 Nginx，复用它转发 `/v1/` 和 `/healthz` 到 `127.0.0.1:17860`。需允许至少 8MiB 的请求体（例如设 `client_max_body_size 9m`）并给上传留足超时；仍由应用执行 8MiB 单块上限。

## 6. 初始参数

文件 `/etc/default/agent-handoff-relay`：

```text
RELAY_DATA_DIR=/var/lib/agent-handoff-relay
RELAY_PORT=17860
RELAY_QUOTA_BYTES=10737418240
RELAY_MAX_PAYLOAD_BYTES=1073741824
RELAY_TTL_DAYS=30
```

变更后重启服务。配额统计所有尚未释放的上传和就绪包的声明大小，不是在磁盘写满后才检查；数据库、日志、备份和操作系统不计入此逻辑配额，仍需保留磁盘余量。

本版所有包按创建时间 30 天过期，每分钟清理一次，元数据保留以便查询。下载不会自动删除包，completed 回执也不立即删除。若要更长保留期，调整 TTL 后再创建新包；现有包的过期时间不会因改配置而追溯变化。

## 7. 备份、撤销与升级

数据备份采用短暂停服，以保持包仓库与数据库一致：

```sh
sudo bash /opt/agent-handoff-relay/app/deploy/backup.sh
```

脚本仅在原服务运行时停服，结束后恢复；备份保存到 `/var/backups/agent-handoff-relay`，同时生成 SHA-256 文件。它包含数据目录中的数据库、密文和设备凭证，不包含应用、Caddy 配置、环境配置或各客户端的 age 私钥。单独保存 `/etc/default/agent-handoff-relay` 和代理配置，并在客户端保管解密私钥。

把备份拉到另一设备，才是异机备份。备份时间取决于包仓库大小，停服期间客户端稍后重试。

在**同一台服务器、相同应用版本**上恢复时，先确定备份路径，校验后停服，将现有目录移到另一位置保留，再恢复：

```sh
# 把时间戳换成实际备份名。
BACKUP_FILE=/var/backups/agent-handoff-relay/relay-20261030T040000Z.tar.gz
sudo sha256sum --check "$BACKUP_FILE.sha256"
sudo systemctl stop agent-handoff-relay
SAVED_DATA="/var/lib/agent-handoff-relay.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
sudo test ! -e "$SAVED_DATA"
sudo mv /var/lib/agent-handoff-relay "$SAVED_DATA"
sudo install -d -o handoff-relay -g handoff-relay -m 0700 /var/lib/agent-handoff-relay
sudo tar --no-same-owner -xzf "$BACKUP_FILE" -C /var/lib/agent-handoff-relay
sudo chown -R handoff-relay:handoff-relay /var/lib/agent-handoff-relay
sudo systemctl start agent-handoff-relay
curl --fail http://127.0.0.1:17860/healthz
```

按顺序逐条执行；任何命令失败都先处理报错，再继续。仅恢复自己生成且校验成功的备份。恢复后凭证和投递状态回到备份时点：备份之后的轮换、撤销和回执需要重新核对，尤其应重新撤销已经停用的凭证。新机器恢复还要先准备服务账号、相同版本运行环境和站点配置，不能只解压数据包。

撤销某设备：

```sh
sudo -u handoff-relay /opt/agent-handoff-relay/node/bin/node /opt/agent-handoff-relay/app/bin/relay.mjs device revoke --data /var/lib/agent-handoff-relay --id win-office
```

轮换凭证：使用 `device rotate`，同样指定 id、实际 HTTPS URL 和一个全新 out 路径。旧 token 对新请求立即失效；已经开始向网络发送的响应无法收回。

升级时先备份数据和配置并停服务；保存旧 `/opt/agent-handoff-relay/app`，将新版本源码复制到新目录后切换。应用保持 root 所有、服务账号可读和可遍历，禁止服务账号写入代码。不要删除 `/var/lib/agent-handoff-relay` 或覆盖设备凭证。0.1.0 只支持 schema 1；未来版本若有数据库迁移，回滚应用前要确认旧程序能读取新 schema，不能只替换代码冒险启动。

## 8. 第一轮验收

1. 两个不同设备的 `whoami` 分别返回自己的 id。
2. A 用真实 age 公钥加密一份合成包，发送给 B。
3. B 的 inbox 看见任务，C 的 inbox 和任务 API 均不能读取它。
4. B 下载并解密；原文件 SHA-256 与解密结果一致。
5. 发送中断后以同一 id 重跑，offset 从已确认进度继续。
6. B 回传 verified/accepted/started/completed，A 查询看到这些设备声明。
7. B→A 再发一份，验证反向也成立。

客户端命令见 [CLIENTS.md](CLIENTS.md)。这些步骤验收中转传输；插件接入请继续按 [插件说明](../../agent-handoff-connect/README.md) 操作。

参考：[Node.js 下载](https://nodejs.org/en/download)、[Caddy Ubuntu 安装](https://caddyserver.com/docs/install)、[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)。

## 9. 启用管理界面与安装包下载

首次安装器只启用中转。按 [ADMIN.md](ADMIN.md) 生成独立管理员凭证、设置 HTTPS Origin 和管理端口，并为管理服务单独配置 HTTPS 代理。可选插件下载目录见 [web/downloads/README.md](../web/downloads/README.md)。
