#!/usr/bin/env bash
# 部署前端与服务端到 server:/root/zhibai（不动书籍与数据），保留之前的版本以便回滚
# 用法：
#   bash tools/deploy.sh            部署当前代码；重启后自检失败会自动退回上一版
#   bash tools/deploy.sh rollback   退回上一次部署前的版本
#   bash tools/deploy.sh list       列出服务器上保留的版本
# 旧版本存放在 /root/zhibai/.releases/<时间>/，保留最近 5 个。
set -euo pipefail
cd "$(dirname "$0")/.."
. tools/remote.sh
cmd="${1:-deploy}"

# 远端公用函数：快照当前版本、恢复某个快照、重启并自检
COMMON='
set -euo pipefail
cd "$1"
mkdir -p .releases
LIVE="app server.js build-catalog.mjs meta.json"
snapshot() { # $1 目标目录
  mkdir -p "$1"
  for f in $LIVE; do if [ -e "$f" ]; then cp -a "$f" "$1/"; fi; done
}
restore() { # $1 快照目录：先换上快照里的文件，再把快照里没有的文件挪走
  rm -rf app.restore && cp -a "$1/app" app.restore && rm -rf app && mv app.restore app
  for f in server.js build-catalog.mjs meta.json; do
    if [ -e "$1/$f" ]; then cp -a "$1/$f" .; else rm -f "$f"; fi
  done
}
restart() {
  if systemctl is-enabled zhibai >/dev/null 2>&1; then
    systemctl restart zhibai
    for i in $(seq 1 20); do
      sleep 0.5
      if curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-8730}/read/api/session"; then return 0; fi
    done
    echo "服务没有正常启动：" >&2; journalctl -u zhibai -n 20 --no-pager >&2 || true
    return 1
  fi
}
prune() { ls -1d .releases/*/ 2>/dev/null | sort | head -n -5 | xargs -r rm -rf; }
'

case "$cmd" in
  deploy)
    files=(app server/server.js server/build-catalog.mjs)
    if [ -f server/meta.json ]; then files+=(server/meta.json); fi
    rev=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
    tar --exclude='*.map' -cf - "${files[@]}" | "$SSH" -o BatchMode=yes "$ZHIBAI_HOST" "cat > $(printf %q "$ZHIBAI_DIR")/.deploy.tar"
    remote <<REMOTE
$COMMON
rm -rf .deploy && mkdir .deploy && tar -xf .deploy.tar -C .deploy && rm -f .deploy.tar
snap=.releases/\$(date +%Y%m%d-%H%M%S)
if [ -d app ]; then snapshot "\$snap"; echo "已保存当前版本到 \$snap"; fi
rm -rf app.new && mv .deploy/app app.new && rm -rf app && mv app.new app
cp .deploy/server/server.js .deploy/server/build-catalog.mjs .
if [ -f .deploy/server/meta.json ]; then cp .deploy/server/meta.json .; fi
rm -rf .deploy
echo "$rev" > app/REVISION
if ! restart; then
  if [ -d "\$snap" ]; then echo "自检失败，退回上一版" >&2; restore "\$snap"; restart || true; fi
  exit 1
fi
prune
echo "deployed $rev (\$(du -sh app | cut -f1))"
REMOTE
    ;;
  rollback)
    remote <<REMOTE
$COMMON
prev=\$(ls -1d .releases/*/ 2>/dev/null | grep -v -- '-rolledback/' | sort | tail -n 1 || true)
if [ -z "\$prev" ]; then echo "没有可退回的版本" >&2; exit 1; fi
prev=\${prev%/}
# 当前版本也留一份（标记为 rolledback，之后的 rollback 会跳过它）
snapshot ".releases/\$(date +%Y%m%d-%H%M%S)-rolledback"
restore "\$prev"
rm -rf "\$prev"
restart
echo "已退回到 \$prev（\$(cat app/REVISION 2>/dev/null || echo 未知版本)）"
REMOTE
    ;;
  list)
    remote <<'REMOTE'
cd "$1"
echo "当前：$(cat app/REVISION 2>/dev/null || echo 未知版本)"
for d in $(ls -1d .releases/*/ 2>/dev/null | sort -r); do echo "  ${d%/}  $(cat "$d/app/REVISION" 2>/dev/null || echo '?')"; done
REMOTE
    ;;
  *) echo "用法：bash tools/deploy.sh [deploy|rollback|list]" >&2; exit 2 ;;
esac
