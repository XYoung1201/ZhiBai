# 供部署脚本共用：找 ssh、确定目标主机与目录。被 source，不单独执行。
# 可用环境变量覆盖：ZHIBAI_HOST（默认 SSH 别名 server）、ZHIBAI_DIR（默认 /root/zhibai）、SSH（ssh 可执行文件）
ZHIBAI_HOST="${ZHIBAI_HOST:-server}"
ZHIBAI_DIR="${ZHIBAI_DIR:-/root/zhibai}"
if [ -z "${SSH:-}" ]; then
  if command -v ssh >/dev/null 2>&1; then SSH=ssh
  elif [ -x "/c/Program Files/Git/usr/bin/ssh.exe" ]; then SSH="/c/Program Files/Git/usr/bin/ssh.exe"
  else echo "找不到 ssh，可用 SSH=/path/to/ssh 指定" >&2; exit 1; fi
fi
remote() { "$SSH" -o BatchMode=yes "$@" "$ZHIBAI_HOST" "bash -s -- $(printf '%q ' "$ZHIBAI_DIR")"; }
