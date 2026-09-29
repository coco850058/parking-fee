#!/usr/bin/env bash
# 对运行中的 SQLite 数据库做一致性备份，压缩后按天数清理。
# 可选环境变量：ENV_FILE、DB_PATH、DATABASE_PATH、BACKUP_DIR、RETENTION_DAYS、OSS_DEST。
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

ENV_FILE="${ENV_FILE:-/etc/parkfee/parkfee.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/parkfee}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
OSS_DEST="${OSS_DEST:-}"

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

# 限制为无空白、引号和控制字符的绝对路径，避免 SQLite 元命令被注入。
validate_safe_absolute_path() {
  local label="$1"
  local value="$2"
  [[ "$value" == /* ]] || die "$label 必须是绝对路径：$value"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "$label 含有不安全字符：$value"
  [[ "$value" != "/" ]] || die "$label 不能是根目录"
  [[ "$value" != *"/../"* && "$value" != */.. && "$value" != *"/./"* ]] || die "$label 不能包含 . 或 .. 路径段"
}

# 只读取简单的 KEY=value；生产路径不应依赖 shell 展开。
read_env_value() {
  local key="$1"
  local value
  [[ -r "$ENV_FILE" ]] || return 1
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
    END { if (result != "") print result }
  ' "$ENV_FILE")"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

require_command sqlite3
require_command gzip
require_command find
require_command awk

env_db_path="$(read_env_value DB_PATH || true)"
env_database_path="$(read_env_value DATABASE_PATH || true)"
if [[ -n "$env_db_path" && -n "$env_database_path" && "$env_db_path" != "$env_database_path" ]]; then
  die "$ENV_FILE 中 DB_PATH 与 DATABASE_PATH 指向不同，拒绝冒险备份"
fi
if [[ -n "${DB_PATH:-}" && -n "${DATABASE_PATH:-}" && "$DB_PATH" != "$DATABASE_PATH" ]]; then
  die "DB_PATH 与 DATABASE_PATH 环境变量指向不同，拒绝冒险备份"
fi
DB_PATH="${DB_PATH:-${DATABASE_PATH:-${env_db_path:-$env_database_path}}}"
[[ -n "$DB_PATH" ]] || die "未设置 DB_PATH，且无法从 $ENV_FILE 读取"

validate_safe_absolute_path "DB_PATH" "$DB_PATH"
validate_safe_absolute_path "BACKUP_DIR" "$BACKUP_DIR"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "RETENTION_DAYS 必须是整数"
(( RETENTION_DAYS >= 1 && RETENTION_DAYS <= 3650 )) || die "RETENTION_DAYS 必须在 1 到 3650 之间"
[[ -f "$DB_PATH" ]] || die "数据库不存在或不是普通文件：$DB_PATH"
[[ ! -L "$DB_PATH" ]] || die "为避免备份错误目标，DB_PATH 不允许是符号链接"

case "$BACKUP_DIR" in
  /bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/sys|/tmp|/usr|/var|/var/lib)
    die "BACKUP_DIR 过于宽泛：$BACKUP_DIR"
    ;;
esac

if [[ -e "$BACKUP_DIR" && -L "$BACKUP_DIR" ]]; then
  die "BACKUP_DIR 不允许是符号链接：$BACKUP_DIR"
fi
install -d -m 0700 "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
base_name="parkfee-${timestamp}-$$"
tmp_db="$(mktemp "$BACKUP_DIR/.${base_name}.XXXXXX.sqlite")"
tmp_gz="${tmp_db}.gz"
final_gz="$BACKUP_DIR/${base_name}.sqlite.gz"
final_sha="$final_gz.sha256"

cleanup() {
  rm -f -- "$tmp_db" "$tmp_gz"
}
trap cleanup EXIT INT TERM

sqlite3 "$DB_PATH" ".timeout 10000" ".backup '$tmp_db'"
check_result="$(sqlite3 "$tmp_db" 'PRAGMA quick_check;')"
[[ "$check_result" == "ok" ]] || die "备份完整性检查失败：$check_result"

gzip -c -- "$tmp_db" > "$tmp_gz"
gzip -t -- "$tmp_gz"
mv -- "$tmp_gz" "$final_gz"

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$BACKUP_DIR"
    sha256sum "$(basename "$final_gz")" > "$(basename "$final_sha")"
  )
elif command -v shasum >/dev/null 2>&1; then
  (
    cd "$BACKUP_DIR"
    shasum -a 256 "$(basename "$final_gz")" > "$(basename "$final_sha")"
  )
else
  die "缺少 sha256sum 或 shasum，备份已生成但无法写校验文件：$final_gz"
fi

upload_failed=0
if [[ -n "$OSS_DEST" ]]; then
  [[ "$OSS_DEST" == oss://* ]] || die "OSS_DEST 必须以 oss:// 开头"
  require_command ossutil
  oss_prefix="${OSS_DEST%/}"
  if ! ossutil cp -f "$final_gz" "$oss_prefix/$(basename "$final_gz")"; then
    upload_failed=1
  fi
  if ! ossutil cp -f "$final_sha" "$oss_prefix/$(basename "$final_sha")"; then
    upload_failed=1
  fi
fi

# 仅删除本脚本命名的常规文件，不跟随目录或符号链接。
find "$BACKUP_DIR" -xdev -maxdepth 1 -type f \
  \( -name 'parkfee-*.sqlite.gz' -o -name 'parkfee-*.sqlite.gz.sha256' \) \
  -mtime "+$RETENTION_DAYS" -delete

if (( upload_failed != 0 )); then
  die "本地备份已完成，但 OSS 上传失败：$final_gz"
fi

printf '备份完成：%s\n' "$final_gz"
