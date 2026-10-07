#!/usr/bin/env bash
# =====================================================================
#  Tradepilo – kurulum / güncelleme (root olarak çalıştırın)
#  İlk kurulumda ve her güncellemede aynı komut:  bash deploy.sh
#  Okur: /etc/tradepilo/deploy.conf  (DOMAIN, API_REPO, WEB_REPO, BRANCH)
#        WEB_REPO boşsa: sadece backend (frontend Vercel'de, DOMAIN = api.alanadi.com)
#        /etc/tradepilo/api.env      (backend ortam değişkenleri)
# =====================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "root olarak çalıştırın"; exit 1; }
CONF=/etc/tradepilo/deploy.conf
[ -f "$CONF" ] || { echo "$CONF yok (deploy.conf.example'a bakın)"; exit 1; }
[ -f /etc/tradepilo/api.env ] || { echo "/etc/tradepilo/api.env yok (api.env.example'a bakın)"; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
: "${DOMAIN:?DOMAIN gerekli}" "${API_REPO:?API_REPO gerekli}"
WEB_REPO="${WEB_REPO:-}"
BRANCH="${BRANCH:-main}"
HOME_DIR=/opt/tradepilo
as_app() { sudo -u tradepilo -H bash -lc "$*"; }

sync_repo() { # $1 repo url, $2 hedef klasör
  if [ -d "$2/.git" ]; then
    as_app "cd '$2' && git fetch --quiet origin '$BRANCH' && git reset --quiet --hard 'origin/$BRANCH'"
  else
    as_app "git clone --quiet --branch '$BRANCH' '$1' '$2'"
  fi
  echo "   $(basename "$2"): $(as_app "cd '$2' && git log -1 --format='%h %s'")"
}

echo "==> Kod çekiliyor"
sync_repo "$API_REPO" "$HOME_DIR/api"
[ -n "$WEB_REPO" ] && sync_repo "$WEB_REPO" "$HOME_DIR/web"

echo "==> Backend bağımlılıkları"
as_app "cd $HOME_DIR/api && npm ci --no-audit --no-fund"

if [ -n "$WEB_REPO" ]; then
  echo "==> Frontend derleniyor (aynı alan adı: /api/v1 ve /ws)"
  as_app "cd $HOME_DIR/web && npm ci --no-audit --no-fund && VITE_USE_MOCK=false VITE_API_URL=/api/v1 VITE_WS_URL=/ws npm run build"
  rsync -a --delete "$HOME_DIR/web/dist/" /var/www/tradepilo/
  chown -R tradepilo:tradepilo /var/www/tradepilo
  CADDY_SRC="$HOME_DIR/api/deploy/Caddyfile"
else
  echo "==> Frontend atlandı (WEB_REPO boş – frontend Vercel'de)"
  CADDY_SRC="$HOME_DIR/api/deploy/Caddyfile.api"
fi

echo "==> Backend servisi"
install -m 644 "$HOME_DIR/api/deploy/tradepilo-api.service" /etc/systemd/system/tradepilo-api.service
chmod 640 /etc/tradepilo/api.env && chown root:tradepilo /etc/tradepilo/api.env
systemctl daemon-reload
systemctl enable tradepilo-api >/dev/null
systemctl restart tradepilo-api

echo -n "   API bekleniyor"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/api/v1/health >/dev/null 2>&1; then echo " ✓"; break; fi
  echo -n "."; sleep 2
  if [ "$i" = 60 ]; then echo; echo "API açılmadı. Log:  journalctl -u tradepilo-api -n 80 --no-pager"; exit 1; fi
done

echo "==> Caddy (HTTPS)"
sed "s/__DOMAIN__/$DOMAIN/g" "$CADDY_SRC" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy

echo
echo "✅ Yayında:  https://$DOMAIN"
[ -z "$WEB_REPO" ] && echo "   Test:  https://$DOMAIN/api/v1/health"
echo "   Backend logu:  journalctl -u tradepilo-api -f"
echo "   Caddy logu:    journalctl -u caddy -f"
