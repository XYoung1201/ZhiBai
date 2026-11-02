#!/usr/bin/env bash
# 把书籍文件夹里新增或变动的书同步到云端书库，并重建书目
# 用法：bash _知白/tools/sync-books.sh [书籍目录]   （默认是 _知白 所在的书籍文件夹）
#   例：bash _知白/tools/sync-books.sh "E:/Google Driver/Backup/书影音/Books/书籍"
# 只增不删：服务器上已有的书（按路径与大小判断）不会重复上传
set -euo pipefail
SRC="${1:-$(dirname "$0")/../..}"
cd "$SRC"
SSH="/c/Program Files/Git/usr/bin/ssh.exe"; [ -x "$SSH" ] || SSH=ssh
EXT='pdf|epub|mobi|azw|azw3|fb2|fbz|txt|md|markdown|html|htm|docx|doc|cbz'
# 远端现有文件清单（路径 + 大小）
"$SSH" -o BatchMode=yes server 'cd /root/zhibai/books && find . -type f -printf "%p\t%s\n"' | sort > /tmp/zb-remote.txt
find . -path ./_知白 -prune -o -path ./.claude -prune -o -type f -regextype posix-extended -iregex ".*\.($EXT)$" -printf "%p\t%s\n" | sort > /tmp/zb-local.txt
comm -23 /tmp/zb-local.txt /tmp/zb-remote.txt | cut -f1 > /tmp/zb-new.txt
N=$(wc -l < /tmp/zb-new.txt)
if [ "$N" -eq 0 ]; then echo "书库已是最新"; else
  echo "上传 $N 个文件…"
  tar -cf - -T /tmp/zb-new.txt | "$SSH" -o BatchMode=yes -o Compression=no server 'tar -xf - -C /root/zhibai/books'
fi
"$SSH" -o BatchMode=yes server 'cd /root/zhibai && /root/.nvm/versions/node/v24.22.0/bin/node build-catalog.mjs | tail -1'
