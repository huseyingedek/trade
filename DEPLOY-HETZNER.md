# Tradepilo – Hetzner'e Kurulum

Tek sunucu, iki uygulama:

```
https://tradepilo.com          → Caddy → frontend (statik dosyalar)
https://tradepilo.com/api/...  → Caddy → backend (Node.js, sadece sunucu içinden erişilir)
wss://tradepilo.com/ws         → Caddy → backend (canlı veri)
Veritabanı                     → Neon (Frankfurt)
```

Caddy HTTPS sertifikasını (Let's Encrypt) kendisi alır ve yeniler.

---

## 1) Sunucuyu oluştur (Hetzner Console → Add Server)

| Ayar | Seçim |
|---|---|
| **Location** | **Nuremberg** veya **Falkenstein** (Almanya). ⚠️ Ashburn/Hillsboro (ABD) **seçmeyin** – Binance ABD IP'lerini engeller. |
| **Image** | **Ubuntu 24.04** |
| **Type** | Shared vCPU, **en az 2 vCPU / 4 GB RAM** (x86 veya Arm fark etmez) |
| **Networking** | Public IPv4 + IPv6 |
| **SSH keys** | Aşağıdaki gibi oluşturup ekleyin |
| **Backups** | Açın (önerilir) |
| **Name** | `tradepilo-1` |

**SSH anahtarı (Windows PowerShell):**

```powershell
ssh-keygen -t ed25519
type $env:USERPROFILE\.ssh\id_ed25519.pub
```

Çıkan satırı Hetzner'de *SSH keys → Add SSH key* alanına yapıştırın.

## 2) Alan adı

Alan adını aldıysanız DNS panelinden:

| Tür | Ad | Değer |
|---|---|---|
| A | `@` | sunucunun IPv4 adresi |
| AAAA | `@` | sunucunun IPv6 adresi |

Henüz alan adı yoksa geçici olarak **`<IP-tirelerle>.sslip.io`** kullanabilirsiniz (örn. IP `116.203.10.20` ise `116-203-10-20.sslip.io`). HTTPS bununla da çalışır; alan adını aldığınızda sadece ayarı değiştirip `deploy.sh`'ı tekrar çalıştırırsınız.

## 3) Kodu GitHub'a gönder

İki **private** repo: `tradepilo-api` (tradenest-api klasörü) ve `tradepilo-web` (hirenest-admin klasörü). `.env` dosyaları gitignore'da; gönderilmez.

## 4) Sunucuyu hazırla

Bilgisayarınızda (PowerShell), `traiding` klasöründen iki script'i sunucuya kopyalayın:

```powershell
cd C:\Users\hgede\Desktop\traiding\tradenest-api\deploy
scp setup-server.sh deploy.sh root@SUNUCU_IP:/root/
```

Sunucuya bağlanıp kurulumu çalıştırın:

```powershell
ssh root@SUNUCU_IP
```
```bash
sed -i 's/\r$//' /root/*.sh      # Windows satır sonlarını temizler (zararsız)
bash /root/setup-server.sh
```

Bitince ekranda **iki deploy anahtarı** yazar. GitHub'da:

- `tradepilo-api` → Settings → Deploy keys → Add deploy key → **1. anahtar** (Allow write access **kapalı**)
- `tradepilo-web` → Settings → Deploy keys → Add deploy key → **2. anahtar**

## 5) Ayar dosyaları (sunucuda)

```bash
nano /etc/tradepilo/deploy.conf
```
`deploy.conf.example` içeriğini yapıştırıp düzenleyin: `DOMAIN`, GitHub kullanıcı adınız.

```bash
nano /etc/tradepilo/api.env
```
`api.env.example` içeriğini yapıştırıp doldurun:

- `DATABASE_URL`: Neon Frankfurt adresi (havuzsuz, `channel_binding` yok)
- `ENCRYPTION_KEY`: **bilgisayarınızdaki `tradenest-api\.env` ile aynı** (admin 2FA'yı orada kurduysanız farklı anahtarla çözülemez)
- `JWT_SECRET`: yeni rastgele değer: `openssl rand -base64 48`
- `CORS_ORIGIN` / `APP_URL`: `https://` + alan adınız
- `SEED_ADMIN_PASSWORD`: güçlü şifre
- `RESEND_API_KEY`: e-posta için (şifre sıfırlama)

Kaydet: `Ctrl+O`, `Enter`, çık: `Ctrl+X`.

## 6) Yayına al

```bash
bash /root/deploy.sh
```

Script sırasıyla şunları yapar: kodu çeker, bağımlılıkları kurar, frontend'i derler, backend'i servis olarak başlatır, sağlık kontrolünü bekler ve HTTPS'i açar. Sonunda `✅ Yayında: https://...` yazar.

İlk girişte admin hesabıyla 2FA kurulumunu yapın.

## Güncelleme (her yeni sürümde)

```powershell
# bilgisayarınızda: değişiklikleri GitHub'a gönderin
git add . ; git commit -m "..." ; git push
```
```bash
# sunucuda
bash /opt/tradepilo/api/deploy/deploy.sh
```

## İzleme

| Ne | Komut |
|---|---|
| Backend logu (canlı) | `journalctl -u tradepilo-api -f` |
| Son 100 satır | `journalctl -u tradepilo-api -n 100 --no-pager` |
| Backend'i yeniden başlat | `systemctl restart tradepilo-api` |
| Caddy / HTTPS logu | `journalctl -u caddy -f` |
| Erişim logu | `tail -f /var/log/caddy/tradepilo.log` |
| Durum | `systemctl status tradepilo-api caddy` |

Ücretsiz bir uptime servisi (örn. UptimeRobot) ile `https://ALANADINIZ/api/v1/health` adresini izleyin; site düşerse e-posta gelir.

## Güvenlik özeti

- Güvenlik duvarı sadece 22 (SSH), 80, 443 portlarına izin verir; backend 127.0.0.1'e bağlıdır, dışarıdan erişilemez.
- SSH sadece anahtarla; şifreyle giriş kapalı. fail2ban kaba kuvvet denemelerini engeller.
- Güvenlik güncellemeleri otomatik kurulur.
- `/etc/tradepilo/api.env` sadece root ve uygulama kullanıcısı tarafından okunabilir.
- Oturum anahtarları ne backend ne Caddy loglarına yazılır.
