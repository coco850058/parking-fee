# OpenCloudOS 9 部署模板

本目录是 OpenCloudOS 9 + Nginx + systemd 的部署示例。文中的 `pay.example.com` 是占位域名，使用前须替换；`deploy/install.sh` 仅支持 Ubuntu/Debian 和 Caddy，不适用于此方案。

目录布局：

```text
/data/parkfee/
  current -> releases/<版本号>       # 运行中的 Linux 构建产物
  releases/<版本号>/                 # 代码、dist、生产依赖；不含密钥
  config/wechat.env                 # 部署机上的受限配置，root:parkfee，0640
  config/parkfee.env                # 生产覆盖项，root:parkfee，0640
  secrets/wechat/*.pem              # root:parkfee，0640
  shared/data/parking.db            # parkfee:parkfee，数据目录 0750
  backups/                          # root:root，0700
```

准备 Node.js >= 22.12、Nginx、`parkfee` 系统用户以及上述目录。`/data/parkfee` 和 `releases` 可由 root 持有、权限为 0755；`config`、`secrets` 与 `secrets/wechat` 用 `root:parkfee`、0750；`shared/data` 用 `parkfee:parkfee`、0750。源码在独立工作区构建，执行 `npm ci && npm run build && npm prune --omit=dev`；必须在服务器的 Linux 环境安装原生依赖。发布时仅复制构建产物和运行依赖到 `releases/<版本号>`，再原子切换 `current`。不要把本地 `.env`、`secrets/` 或开发数据库放入版本目录。

服务先读取 `wechat.env` 中的微信参数，再由 `parkfee.env` 覆盖运行参数。
`/data/parkfee/config/parkfee.env` 至少设置：

```dotenv
NODE_ENV=production
PAYMENT_MODE=wechat
HOST=127.0.0.1
PORT=3100
DB_PATH=/data/parkfee/shared/data/parking.db
PUBLIC_BASE_URL=https://pay.example.com
JWT_SECRET=<至少 32 位随机值>
ADMIN_PASSWORD_HASH=<bcrypt 哈希>
WECHAT_APP_ID=<公众号 AppID>
WECHAT_APP_SECRET=<公众号 AppSecret>
WECHAT_MCH_ID=<商户号>
WECHAT_MCH_SERIAL_NO=<商户 API 证书序列号>
WECHAT_MCH_PRIVATE_KEY_PATH=/data/parkfee/secrets/wechat/apiclient_key.pem
WECHAT_API_V3_KEY=<32 字节 API v3 密钥>
WECHATPAY_PUBLIC_KEY_PATH=/data/parkfee/secrets/wechat/pub_key.pem
WECHATPAY_PUBLIC_KEY_ID=<PUB_KEY_ID_...>
```

确认商户密钥确为 API v3 密钥，且 `parkfee` 用户能读取两份 PEM。服务单元在启动命令中固定生产环境、微信支付模式和本机端口；微信支付公钥或公钥 ID 缺失时，应用会拒绝启动。此时不要把站点切到 `PAYMENT_MODE=mock` 对公网开放。

把 `parkfee.service` 安装到 `/etc/systemd/system/parkfee.service`，确认 `/usr/local/bin/node` 是符合版本要求的实际路径，随后运行 `systemctl daemon-reload && systemctl enable --now parkfee`。先用 `curl --fail http://127.0.0.1:3100/api/health` 检查服务。

取得 `pay.example.com` 的有效 TLS 证书后，将 `parkfee.nginx.conf` 安装为 `/etc/nginx/conf.d/parkfee.conf`。确认 DNS 指向服务器、80/443 可访问，再运行 `nginx -t && systemctl reload nginx`；最后检查 `curl --fail https://pay.example.com/api/health`。SELinux 处于 enforcing 时，Nginx 代理本机端口通常需要 `setsebool -P httpd_can_network_connect 1`。支付通知地址默认是 `https://pay.example.com/api/wechat/pay/notify`，公众号和商户平台的授权域名、支付目录及通知配置也须匹配。

微信公众平台的「网页授权域名」与「JS 接口安全域名」是两项独立配置，均应填写实际部署域名，不要附加协议或路径。公众号下载的原始 `MP_verify_*.txt` 放在服务器 `/var/www/parkfee-wechat/`；Nginx 在 HTTP 和 HTTPS 的站点根路径直接提供该文件（例如 `https://pay.example.com/MP_verify_xxx.txt`），不随应用版本切换丢失。先确认文件返回 200 且内容一致，再到公众号后台保存域名。

用户端“我的缴费记录”只返回当前微信 OpenID 的已支付和已退款订单。管理端整单全额退款使用现有商户 API 私钥、微信支付公钥和 APIv3 密钥；申请时显式指定退款回调 `https://pay.example.com/api/wechat/refund/notify`，无需在商户平台另配回调。退款受理或处理中时仍保留原订单“已支付”状态，只有验签后的成功通知或退款查单确认成功才变为“已退款”。服务每分钟限量只读查单，不自动再次提交退款；`parkfee.service` 的停机超时为 120 秒，以等待当前查单完成。发布该版本前务必先做一致性数据库备份；自动化测试只模拟退款，不能对真实订单试退。

首次启动时会创建初始停车场，生产数据库的 8 项价格均为零，缴费按钮不可用。管理员登录后必须填写商户租户、居民各 1、3、6、12 个月的实际金额，系统才允许下单。新增停车场默认停用，配置全部 8 项非零价格后可启用，并在后台下载专属缴费二维码；已有订单和价格版本在迁移时归入初始停车场。各停车场可独立设置默认车牌前两位，旧场地和新场地默认“新A”。初始管理员密码仅保存在本地忽略目录 `secrets/admin-login.txt`，服务器配置仅存 bcrypt 哈希。

启用第二个停车场并设置独立价格后，旧版本程序可能把全局最新价格误用于首个停车场。此时不能仅切回旧版代码继续收款，也不能用旧数据库备份覆盖新交易；应暂停新订单后前向修复或执行经核对的兼容回退。

安装 `parkfee-backup.service`、`parkfee-backup.timer`、`parkfee-cert-renew.service`、`parkfee-cert-renew.timer` 后启用两个 timer。数据库每天在线备份到 `/data/parkfee/backups`，证书续期仅针对 `pay.example.com`，续期成功后重载 Nginx。HTTP 的 `/.well-known/acme-challenge/` 路径必须保持可访问。
