#!/usr/bin/env bash
# Ubuntu/Debian 无 Docker 部署脚本。
# 用法示例：
#   sudo PARKFEE_DOMAIN=pay.example.com PARKFEE_ENV_FILE=/root/parkfee.env bash deploy/install.sh
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

APP_NAME="parkfee"
SERVICE_USER="parkfee"
SERVICE_GROUP="parkfee"
APP_ROOT="/opt/parkfee"
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
CONFIG_DIR="/etc/parkfee"
TARGET_ENV="$CONFIG_DIR/parkfee.env"
DATA_DIR="/var/lib/parkfee"
LOG_DIR="/var/log/parkfee"
BACKUP_DIR="/var/backups/parkfee"
CADDY_SITES_DIR="/etc/caddy/sites"
CADDY_SITE_FILE="$CADDY_SITES_DIR/parkfee.caddy"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
RUN_TESTS="${RUN_TESTS:-1}"
PARKFEE_DOMAIN="${PARKFEE_DOMAIN:-}"
PARKFEE_ENV_FILE="${PARKFEE_ENV_FILE:-}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

log() {
  printf '[parkfee-install] %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

read_env_value() {
  local key="$1"
  local value
  value="$(awk -v wanted="$key" '
    /^[[:space:]]*#/ { next }
    {
      line=$0
      sub(/^[[:space:]]*/, "", line)
      if (index(line, wanted "=") == 1) {
        sub("^" wanted "=", "", line)
        result=line
      }
    }
    END { print result }
  ' "$TARGET_ENV")"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

require_env_value() {
  local key="$1"
  [[ -n "$(read_env_value "$key")" ]] || die "$TARGET_ENV 未设置 $key"
}

cleanup_path=""
cleanup() {
  if [[ -n "$cleanup_path" && -d "$cleanup_path" && "$cleanup_path" == "$RELEASES_DIR/.staging-"* ]]; then
    rm -rf -- "$cleanup_path"
  fi
}
trap cleanup EXIT INT TERM

[[ "$EUID" -eq 0 ]] || die "请使用 sudo 或 root 运行"
[[ -f /etc/os-release ]] || die "无法识别操作系统"
# shellcheck disable=SC1091
source /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) die "本脚本仅支持 Ubuntu/Debian，当前为：${ID:-unknown}" ;;
esac

# Node.js 与 Caddy 的版本/软件源由运维人员准备；这里只安装发行版自带的通用工具。
missing_packages=()
command -v rsync >/dev/null 2>&1 || missing_packages+=(rsync)
command -v curl >/dev/null 2>&1 || missing_packages+=(curl)
command -v sqlite3 >/dev/null 2>&1 || missing_packages+=(sqlite3)
command -v gzip >/dev/null 2>&1 || missing_packages+=(gzip)
if (( ${#missing_packages[@]} > 0 )); then
  log "安装系统依赖：${missing_packages[*]}"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing_packages[@]}"
fi

[[ "$KEEP_RELEASES" =~ ^[0-9]+$ ]] && (( KEEP_RELEASES >= 2 && KEEP_RELEASES <= 20 )) \
  || die "KEEP_RELEASES 必须是 2 到 20 的整数"
[[ "$RUN_TESTS" == "0" || "$RUN_TESTS" == "1" ]] || die "RUN_TESTS 只能是 0 或 1"

require_command node
require_command npm
require_command systemctl
require_command useradd
require_command runuser
require_command install
require_command rsync
require_command curl
require_command sed
require_command awk
require_command readlink
require_command flock

exec 9>/run/lock/parkfee-install.lock
flock -n 9 || die "已有另一个 parkfee 部署任务在运行"

if [[ -n "$PARKFEE_DOMAIN" ]]; then
  [[ "$PARKFEE_DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] \
    || die "PARKFEE_DOMAIN 不是有效域名（不要包含协议或路径）：$PARKFEE_DOMAIN"
  require_command caddy
fi

NODE_BIN="$(command -v node)"
NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
(( NODE_MAJOR >= 22 )) || die "需要 Node.js >= 22.12，当前为 $NODE_VERSION"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=12) ? 0 : 1)' \
  || die "需要 Node.js >= 22.12，当前为 $NODE_VERSION"
[[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/package-lock.json" ]] \
  || die "源码目录缺少 package.json 或 package-lock.json：$SOURCE_DIR"

if ! getent group "$SERVICE_GROUP" >/dev/null; then
  groupadd --system "$SERVICE_GROUP"
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

case "$NODE_BIN" in
  /root/*|/home/*) die "Node.js 位于用户私有目录，systemd 沙箱无法稳定访问：$NODE_BIN" ;;
esac
runuser -u "$SERVICE_USER" -- "$NODE_BIN" --version >/dev/null \
  || die "parkfee 系统用户无法执行 Node.js：$NODE_BIN"

install -d -m 0755 -o root -g root "$APP_ROOT" "$RELEASES_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$DATA_DIR" "$LOG_DIR"
install -d -m 0700 -o root -g root "$BACKUP_DIR"
install -d -m 0750 -o root -g "$SERVICE_GROUP" "$CONFIG_DIR" "$CONFIG_DIR/wechat"

if [[ -n "$PARKFEE_ENV_FILE" ]]; then
  [[ "$PARKFEE_ENV_FILE" == /* && -f "$PARKFEE_ENV_FILE" && ! -L "$PARKFEE_ENV_FILE" ]] \
    || die "PARKFEE_ENV_FILE 必须是存在的绝对路径普通文件，且不能是符号链接"
  install -m 0640 -o root -g "$SERVICE_GROUP" "$PARKFEE_ENV_FILE" "$TARGET_ENV"
elif [[ ! -f "$TARGET_ENV" ]]; then
  install -m 0640 -o root -g "$SERVICE_GROUP" "$SOURCE_DIR/.env.example" "$TARGET_ENV"
  sed -i \
    -e 's|^NODE_ENV=.*|NODE_ENV=production|' \
    -e 's|^DB_PATH=.*|DB_PATH=/var/lib/parkfee/parking.db|' \
    -e 's|^ADMIN_PASSWORD=.*|# ADMIN_PASSWORD 仅供本地开发，生产环境不使用|' \
    -e 's|^PAYMENT_MODE=.*|PAYMENT_MODE=wechat|' \
    "$TARGET_ENV"
  log "已创建配置模板：$TARGET_ENV"
  log "请先填写域名、管理员密码哈希和微信密钥，然后重新运行本脚本。"
  exit 2
fi
chown root:"$SERVICE_GROUP" "$TARGET_ENV"
chmod 0640 "$TARGET_ENV"

if grep -Eq '^JWT_SECRET=replace-' "$TARGET_ENV"; then
  die "$TARGET_ENV 仍包含示例密钥，请替换为随机值"
fi
if ! grep -Eq '^ADMIN_PASSWORD_HASH=.{20,}$' "$TARGET_ENV"; then
  die "$TARGET_ENV 未设置有效的 ADMIN_PASSWORD_HASH"
fi
[[ "$(read_env_value NODE_ENV)" == "production" ]] || die "$TARGET_ENV 中 NODE_ENV 必须为 production"
[[ "$(read_env_value HOST)" == "127.0.0.1" ]] || die "$TARGET_ENV 中 HOST 必须为 127.0.0.1"
[[ "$(read_env_value PORT)" == "3000" ]] || die "$TARGET_ENV 中 PORT 必须为 3000（与 Caddy 和健康检查保持一致）"
[[ "$(read_env_value PAYMENT_MODE)" == "wechat" ]] || die "$TARGET_ENV 中 PAYMENT_MODE 必须为 wechat"
[[ "$(read_env_value PUBLIC_BASE_URL)" == https://* ]] || die "$TARGET_ENV 中 PUBLIC_BASE_URL 必须是 HTTPS 地址"
db_path="$(read_env_value DB_PATH)"
database_path="$(read_env_value DATABASE_PATH)"
if [[ -n "$db_path" && -n "$database_path" && "$db_path" != "$database_path" ]]; then
  die "$TARGET_ENV 中 DB_PATH 与 DATABASE_PATH 指向不同"
fi
db_path="${db_path:-$database_path}"
[[ "$db_path" == /* ]] || die "$TARGET_ENV 中 DB_PATH 必须是绝对路径"
[[ "$db_path" == "$DATA_DIR/"* ]] \
  || die "$TARGET_ENV 中 DB_PATH 必须位于 $DATA_DIR 内（与 systemd 写入沙箱保持一致）"
if [[ -n "$PARKFEE_DOMAIN" ]]; then
  public_base_url="$(read_env_value PUBLIC_BASE_URL)"
  [[ "${public_base_url%/}" == "https://$PARKFEE_DOMAIN" ]] \
    || die "PUBLIC_BASE_URL 必须与 PARKFEE_DOMAIN 一致：期望 https://$PARKFEE_DOMAIN"
fi
jwt_secret="$(read_env_value JWT_SECRET)"
(( ${#jwt_secret} >= 32 )) || die "$TARGET_ENV 中 JWT_SECRET 至少需要 32 个字符"
require_env_value WECHAT_APP_ID
require_env_value WECHAT_APP_SECRET
require_env_value WECHAT_MCH_ID
require_env_value WECHAT_MCH_SERIAL_NO
require_env_value WECHAT_API_V3_KEY
require_env_value WECHATPAY_PUBLIC_KEY_ID
api_v3_key="$(read_env_value WECHAT_API_V3_KEY)"
(( ${#api_v3_key} == 32 )) || die "$TARGET_ENV 中 WECHAT_API_V3_KEY 必须恰好为 32 字节 ASCII 字符"
if [[ -z "$(read_env_value WECHAT_MCH_PRIVATE_KEY_PATH)" && -z "$(read_env_value WECHAT_MCH_PRIVATE_KEY)" ]]; then
  die "$TARGET_ENV 必须设置 WECHAT_MCH_PRIVATE_KEY_PATH 或 WECHAT_MCH_PRIVATE_KEY"
fi
if [[ -z "$(read_env_value WECHATPAY_PUBLIC_KEY_PATH)" && -z "$(read_env_value WECHATPAY_PUBLIC_KEY)" ]]; then
  die "$TARGET_ENV 必须设置 WECHATPAY_PUBLIC_KEY_PATH 或 WECHATPAY_PUBLIC_KEY"
fi

for key_path_name in WECHAT_MCH_PRIVATE_KEY_PATH WECHATPAY_PUBLIC_KEY_PATH; do
  key_path="$(read_env_value "$key_path_name")"
  [[ -z "$key_path" ]] && continue
  [[ "$key_path" == /* && -f "$key_path" && ! -L "$key_path" ]] \
    || die "$key_path_name 必须是存在的绝对路径普通文件"
  runuser -u "$SERVICE_USER" -- test -r "$key_path" \
    || die "parkfee 系统用户无法读取 $key_path_name：$key_path"
done

if [[ -f "$db_path" ]]; then
  log "发布前创建 SQLite 一致性备份"
  ENV_FILE="$TARGET_ENV" DB_PATH="$db_path" BACKUP_DIR="$BACKUP_DIR" OSS_DEST="" \
    bash "$SCRIPT_DIR/backup.sh"
fi

release_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
stage_dir="$RELEASES_DIR/.staging-$release_id"
final_dir="$RELEASES_DIR/$release_id"
cleanup_path="$stage_dir"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$stage_dir"

log "复制源码到隔离构建目录"
rsync -a \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'data/' \
  --exclude 'backups/' \
  --exclude '*.log' \
  "$SOURCE_DIR/" "$stage_dir/"
chown -R "$SERVICE_USER":"$SERVICE_GROUP" "$stage_dir"

log "安装锁定依赖并构建（Node.js $NODE_VERSION）"
runuser -u "$SERVICE_USER" -- env HOME="$DATA_DIR" npm --prefix "$stage_dir" ci --no-audit --no-fund
if [[ "$RUN_TESTS" == "1" ]]; then
  runuser -u "$SERVICE_USER" -- env HOME="$DATA_DIR" npm --prefix "$stage_dir" test
fi
runuser -u "$SERVICE_USER" -- env HOME="$DATA_DIR" npm --prefix "$stage_dir" run build
runuser -u "$SERVICE_USER" -- env HOME="$DATA_DIR" npm --prefix "$stage_dir" prune --omit=dev --no-audit
[[ -f "$stage_dir/dist/server/index.js" ]] || die "构建产物不存在：dist/server/index.js"

previous_target=""
if [[ -L "$CURRENT_LINK" ]]; then
  previous_target="$(readlink "$CURRENT_LINK")"
fi
mv -- "$stage_dir" "$final_dir"
cleanup_path=""
ln -sfn "releases/$release_id" "$APP_ROOT/.current-new"
mv -Tf -- "$APP_ROOT/.current-new" "$CURRENT_LINK"

service_tmp="$(mktemp)"
cp "$SCRIPT_DIR/parkfee.service" "$service_tmp"
sed -i "s|^ExecStart=.*|ExecStart=$NODE_BIN dist/server/index.js|" "$service_tmp"
install -m 0644 -o root -g root "$service_tmp" "/etc/systemd/system/$APP_NAME.service"
rm -f -- "$service_tmp"
install -m 0750 -o root -g "$SERVICE_GROUP" "$SCRIPT_DIR/backup.sh" /usr/local/sbin/parkfee-backup
install -m 0644 -o root -g root "$SCRIPT_DIR/parkfee-backup.service" /etc/systemd/system/parkfee-backup.service
install -m 0644 -o root -g root "$SCRIPT_DIR/parkfee-backup.timer" /etc/systemd/system/parkfee-backup.timer

systemctl daemon-reload
systemctl enable "$APP_NAME.service"
systemctl enable --now parkfee-backup.timer
systemctl restart "$APP_NAME.service"

if ! curl --fail --silent --show-error --retry 5 --retry-delay 1 --max-time 3 \
  http://127.0.0.1:3000/api/health >/dev/null; then
  systemctl --no-pager --full status "$APP_NAME.service" || true
  if [[ "$previous_target" =~ ^releases/20[0-9]{6}T[0-9]{6}Z-[0-9]+$ && -d "$APP_ROOT/$previous_target" ]]; then
    log "健康检查失败，自动回滚到 $previous_target"
    ln -sfn "$previous_target" "$APP_ROOT/.current-rollback"
    mv -Tf -- "$APP_ROOT/.current-rollback" "$CURRENT_LINK"
    systemctl restart "$APP_NAME.service"
  fi
  die "应用健康检查失败；已保留失败版本用于排查"
fi

if [[ -n "$PARKFEE_DOMAIN" ]]; then
  caddy_tmp="$(mktemp)"
  sed "s/__PARKFEE_DOMAIN__/$PARKFEE_DOMAIN/g" "$SCRIPT_DIR/Caddyfile" > "$caddy_tmp"
  install -d -m 0755 -o root -g root /etc/caddy "$CADDY_SITES_DIR"

  caddy_main_backup="$(mktemp)"
  caddy_site_backup="$(mktemp)"
  caddy_main_existed=0
  caddy_site_existed=0
  if [[ -f /etc/caddy/Caddyfile ]]; then
    cp /etc/caddy/Caddyfile "$caddy_main_backup"
    caddy_main_existed=1
  else
    : > "$caddy_main_backup"
  fi
  if [[ -f "$CADDY_SITE_FILE" ]]; then
    cp "$CADDY_SITE_FILE" "$caddy_site_backup"
    caddy_site_existed=1
  else
    : > "$caddy_site_backup"
  fi

  install -m 0644 -o root -g root "$caddy_tmp" "$CADDY_SITE_FILE"
  if [[ ! -f /etc/caddy/Caddyfile ]]; then
    printf '# Parkfee 与其他站点均从独立文件导入\nimport /etc/caddy/sites/*.caddy\n' \
      > /etc/caddy/Caddyfile
  elif ! grep -Eq '^[[:space:]]*import[[:space:]]+/etc/caddy/sites/\*\.caddy([[:space:]]*)$' /etc/caddy/Caddyfile; then
    printf '\n# Parkfee 托管站点；不覆盖服务器上的其他 Caddy 配置\nimport /etc/caddy/sites/*.caddy\n' \
      >> /etc/caddy/Caddyfile
  fi

  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    if (( caddy_main_existed == 1 )); then
      install -m 0644 -o root -g root "$caddy_main_backup" /etc/caddy/Caddyfile
    else
      rm -f -- /etc/caddy/Caddyfile
    fi
    if (( caddy_site_existed == 1 )); then
      install -m 0644 -o root -g root "$caddy_site_backup" "$CADDY_SITE_FILE"
    else
      rm -f -- "$CADDY_SITE_FILE"
    fi
    rm -f -- "$caddy_tmp" "$caddy_main_backup" "$caddy_site_backup"
    die "Caddy 配置校验失败，已恢复原配置"
  fi
  rm -f -- "$caddy_tmp"
  rm -f -- "$caddy_main_backup" "$caddy_site_backup"
  systemctl enable caddy
  systemctl reload-or-restart caddy
else
  log "未提供 PARKFEE_DOMAIN，已跳过 Caddy 配置；正式微信支付前必须启用公网 HTTPS。"
fi

# 只清理本应用 releases 目录下、名称符合脚本规则的旧版本。
mapfile -t old_releases < <(
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name '20??????T??????Z-*' -printf '%f\n' \
    | sort -r | tail -n "+$((KEEP_RELEASES + 1))"
)
for old_release in "${old_releases[@]:-}"; do
  [[ -n "$old_release" && "$old_release" =~ ^20[0-9]{6}T[0-9]{6}Z-[0-9]+$ ]] || continue
  rm -rf -- "$RELEASES_DIR/$old_release"
done

log "部署完成：$final_dir"
log "状态：systemctl status $APP_NAME"
log "日志：journalctl -u $APP_NAME -f"
