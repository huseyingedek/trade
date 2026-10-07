#!/usr/bin/env bash
# =====================================================================
#  Tradepilo – sunucu ilk kurulum (Ubuntu 24.04, root olarak BİR KEZ çalıştırın)
#  Kurar: Node.js 22, Caddy (otomatik HTTPS), git, güvenlik duvarı, fail2ban,
#         otomatik güvenlik güncellemeleri, 2 GB swap, uygulama kullanıcısı,
#         GitHub için iki salt-okunur deploy anahtarı.
#  Kullanım:  bash setup-server.sh
# =====================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "root olarak çalıştırın"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Sistem güncelleniyor"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git rsync ufw fail2ban unattended-upgrades ca-certificates gnupg \
  debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node.js 22"
if ! command -v node >/dev/null || ! node -v | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
caddy version

echo "==> Swap (2 GB)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Güvenlik duvarı (sadece SSH, HTTP, HTTPS)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Otomatik güvenlik güncellemeleri + fail2ban"
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now fail2ban

echo "==> SSH: şifreyle girişi kapat (sadece anahtar)"
if [ -s /root/.ssh/authorized_keys ]; then
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/99-tradepilo.conf
  systemctl restart ssh || systemctl restart sshd || true
else
  echo "   UYARI: root için SSH anahtarı yok, şifreyle giriş açık bırakıldı"
fi

echo "==> Uygulama kullanıcısı ve klasörler"
id tradepilo >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/tradepilo --shell /bin/bash tradepilo
install -d -o root -g root -m 755 /etc/tradepilo
install -d -o tradepilo -g tradepilo -m 755 /var/www/tradepilo
install -d -o caddy -g caddy -m 755 /var/log/caddy

echo "==> GitHub deploy anahtarları (her repo için ayrı – GitHub aynı anahtarı iki repoda kabul etmez)"
SSH_DIR=/opt/tradepilo/.ssh
install -d -o tradepilo -g tradepilo -m 700 "$SSH_DIR"
for name in api web; do
  [ -f "$SSH_DIR/id_$name" ] || sudo -u tradepilo ssh-keygen -q -t ed25519 -N "" -f "$SSH_DIR/id_$name" -C "tradepilo-$name-deploy"
done
cat > "$SSH_DIR/config" <<'CFG'
Host github-api
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_api
  IdentitiesOnly yes
Host github-web
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_web
  IdentitiesOnly yes
CFG
ssh-keyscan -t ed25519 github.com >> "$SSH_DIR/known_hosts" 2>/dev/null
chown -R tradepilo:tradepilo "$SSH_DIR"; chmod 600 "$SSH_DIR/config"

cat <<MSG

=====================================================================
 Kurulum tamam. Şimdi GitHub'da iki deploy anahtarı ekleyin
 (Repo → Settings → Deploy keys → Add deploy key, "Allow write access" KAPALI):

 1) BACKEND reposuna (tradepilo-api):
$(cat $SSH_DIR/id_api.pub)

 2) FRONTEND reposuna (tradepilo-web):
$(cat $SSH_DIR/id_web.pub)

 Sonra: /etc/tradepilo/deploy.conf ve /etc/tradepilo/api.env dosyalarını
 oluşturup  bash deploy.sh  çalıştırın (DEPLOY-HETZNER.md).
=====================================================================
MSG
