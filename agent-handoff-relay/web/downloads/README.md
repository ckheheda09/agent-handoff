# 可选安装器下载

此目录默认不含部署文件。后台只公开以下精确路径：

- `agent-handoff-connect-0.3.0.tgz`
- `agent-handoff-connect-0.3.0.tgz.sha256`
- `relay-ca.crt`（可选：仅 CA 公钥证书）
- `INSTALL.md`

在相邻插件目录运行 `npm ci && npm run build && npm pack` 后，把生成的 tgz 复制到此目录并生成 SHA-256 文件。再编写适用于自己的服务 URL 和 CA 的 INSTALL.md。启用下载后需重启中转服务，资源会在创建管理服务时读入内存。

不要放入任何私钥、设备凭证或管理员配置。此目录的部署文件被根目录 .gitignore 忽略。
