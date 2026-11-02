#!/usr/bin/env bash
# 部署前端与服务端到 server:/root/zhibai（不动书籍与数据）
set -euo pipefail
cd "$(dirname "$0")/.."
SSH="/c/Program Files/Git/usr/bin/ssh.exe"; [ -x "$SSH" ] || SSH=ssh
files=(app server/server.js server/build-catalog.mjs)
if [ -f server/meta.json ]; then files+=(server/meta.json); fi
tar --exclude='*.map' -cf - "${files[@]}" | "$SSH" -o BatchMode=yes server '
  set -e; cd /root/zhibai
  rm -rf .deploy && mkdir .deploy && tar -xf - -C .deploy
  rm -rf app.old && [ -d app ] && mv app app.old || true
  mv .deploy/app app
  cp .deploy/server/server.js .deploy/server/build-catalog.mjs .
  if [ -f .deploy/server/meta.json ]; then cp .deploy/server/meta.json .; fi
  rm -rf .deploy app.old
  if systemctl is-enabled zhibai >/dev/null 2>&1; then systemctl restart zhibai; fi
  echo "deployed $(du -sh app | cut -f1)"'
