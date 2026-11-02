#!/usr/bin/env bash
# 一次性安装：在 server 上注册 zhibai 服务（systemd），并在 nginx 的 tools.hogn.top 下挂载 /read/
# 用法（在 Git Bash 里）：bash "E:/Google Driver/Thoughts/书籍/_知白/tools/setup-server.sh"
# 会做的事：
#   1. 写入 /etc/systemd/system/zhibai.service，开机自启，监听 127.0.0.1:8730
#   2. 备份 /etc/nginx/sites-enabled/app.conf 到 /root/app.conf.bak.<时间>，在 tools.hogn.top 段加入 /read/ 反代
#   3. nginx -t 通过后 reload；失败则自动还原备份
# 回滚：systemctl disable --now zhibai; cp /root/app.conf.bak.<时间> /etc/nginx/sites-enabled/app.conf; systemctl reload nginx
set -euo pipefail
SSH="/c/Program Files/Git/usr/bin/ssh.exe"; [ -x "$SSH" ] || SSH=ssh
"$SSH" -o BatchMode=yes server 'bash -s' <<'REMOTE'
set -e
cat > /etc/systemd/system/zhibai.service <<'UNIT'
[Unit]
Description=zhibai reader (tools.hogn.top/read)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/zhibai
Environment=PORT=8730 HOST=127.0.0.1 BASE=/read
ExecStart=/root/.nvm/versions/node/v24.22.0/bin/node /root/zhibai/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now zhibai
CONF=/etc/nginx/sites-enabled/app.conf
BAK=/root/app.conf.bak.$(date +%Y%m%d-%H%M%S)
cp "$CONF" "$BAK"
if ! grep -q 'zhibai' "$CONF"; then
python3 - <<'PY'
p = '/etc/nginx/sites-enabled/app.conf'
s = open(p, encoding='utf-8').read()
anchor = '    server_name tools.hogn.top;\n    include /etc/nginx/snippets/ssl_hogn.conf;\n    client_max_body_size 100m;\n'
assert anchor in s, 'tools.hogn.top server block not found'
s = s.replace(anchor, anchor + '''
    # zhibai: 知白书房（/root/zhibai，127.0.0.1:8730）
    location = /read { return 301 /read/; }
    location ^~ /read/ {
        client_max_body_size 512m;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_pass http://127.0.0.1:8730;
        include /etc/nginx/snippets/proxy_common.conf;
    }
''', 1)
open(p, 'w', encoding='utf-8').write(s)
PY
fi
if nginx -t; then systemctl reload nginx; echo "nginx 已加载 /read/（备份：$BAK）"; else cp "$BAK" "$CONF"; echo "nginx 校验失败，已还原"; exit 1; fi
sleep 1
curl -s -o /dev/null -w "本机检查 /read/ -> %{http_code}\n" http://127.0.0.1:8730/read/
echo "书库钥匙：$(cat /root/zhibai/data/key.txt)"
REMOTE

# 在工具箱首页登记一张卡片（指向 /read/），先备份配置
"$SSH" -o BatchMode=yes server 'bash -s' <<'REMOTE'
set -e
cat > /root/myHTML/zhibai.html <<'HTML'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知白 · 书房</title><meta http-equiv="refresh" content="0;url=/read/"></head><body><a href="/read/">进入知白书房</a></body></html>
HTML
python3 - <<'PY'
import json, shutil, datetime
p = '/root/myHTML/tools.config.json'
bak = p + '.bak.' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
shutil.copy2(p, bak)
d = json.load(open(p, encoding='utf-8'))
entry = {"title": "知白 · 书房", "file": "zhibai.html", "desc": "安静的在线阅读器：PDF、EPUB、TXT、Word 皆可读，多端续读",
         "category": "util", "icon": "ph ph-book-open-text", "heroTitle": "知白", "heroDesc": "把书放上书架，打开就读"}
d['tools'] = [t for t in d['tools'] if t.get('file') != entry['file']]
d['tools'].append(entry)
d['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('工具箱已登记（配置备份：' + bak + '）')
PY
REMOTE
