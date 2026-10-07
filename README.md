# Tradepilo API

Çoklu borsa (kripto · BIST · forex) yönetim platformunun backend'i.
**Node.js 20.19+ · Fastify 5 · PostgreSQL 16 · Prisma 7 · WebSocket**

Frontend: `../hirenest-admin`. API sözleşmesi: `../hirenest-admin/docs/API.md`.

---

> **Sunucuya dağıtım:** [DEPLOY-HETZNER.md](DEPLOY-HETZNER.md) – tek sunucu (Hetzner) + Neon, önerilen · alternatif: [DEPLOY.md](DEPLOY.md) (Render + Vercel)

## Hızlı kurulum (Windows)

Gerekenler: **Node.js 20.19+** (22 LTS önerilir) ve **PostgreSQL 16** (Docker Desktop ya da yerel kurulum).

```powershell
cd traiding\tradenest-api

# 1) Veritabanı – Docker ile (yerel PostgreSQL kullanıyorsanız atlayın, aşağıya bakın)
docker compose up -d

# 2) Bağımlılıklar
npm install

# 3) .env oluştur + gizli anahtarları üret
npm run init

# 4) Prisma client + tablolar + başlangıç verisi
npm run setup

# 5) Çalıştır
npm run dev
```

API → `http://localhost:8080/api/v1` · WebSocket → `ws://localhost:8080/ws`

Frontend'i gerçek API'ye bağlamak için `hirenest-admin\.env` dosyasında `VITE_USE_MOCK=false` olmalı (hazır geliyor), ardından orada `npm run dev`.

### Yerel PostgreSQL (Docker yoksa)

pgAdmin veya `psql` ile:

```sql
CREATE USER tradenest WITH PASSWORD 'tradenest';
CREATE DATABASE tradenest OWNER tradenest;
```

Farklı kullanıcı/şifre kullanırsanız `.env` içindeki `DATABASE_URL`'i güncelleyin.

### İlk giriş

| Hesap | E-posta | Şifre | Not |
|---|---|---|---|
| Süper admin | `admin@tradepilo.com` | `Admin12345!` | İlk girişte **2FA kurulumu** istenir (Google Authenticator / Authy ile QR'ı okutun). |
| Demo yatırımcı | `demo@tradepilo.com` | `Demo12345!` | `SEED_DEMO=true` ise oluşur; 3 paper hesap, geçmiş veri yok. |

> Geliştirmede `.env` içine `DEV_2FA_CODE=000000` yazarsanız bu kod 2FA yerine kabul edilir (production'da devre dışıdır).
> **Canlıya çıkmadan önce admin şifresini değiştirin.**

---

## Komutlar

| Komut | Açıklama |
|---|---|
| `npm run dev` | Geliştirme sunucusu (dosya değişince yeniden başlar) |
| `npm start` | Production başlatma |
| `npm run init` | `.env` oluştur, JWT_SECRET / ENCRYPTION_KEY üret |
| `npm run setup` | `db:generate` + `db:deploy` + `db:seed` |
| `npm run db:migrate` | Şema değişikliği sonrası yeni migration üret (geliştirme) |
| `npm run db:reset` | Veritabanını sıfırla (**tüm veri silinir**) |
| `npm run db:studio` | Prisma Studio – tabloları tarayıcıda görüntüle |
| `npm test` | Birim testleri |
| `npm run test:algo` | Algoritma testleri (31 senaryo: defter, tasfiye, koşullu emirler, SL/TP, botlar, kurallar, risk). **Ayrı bir test veritabanı** ister: `TEST_DATABASE_URL=... npm run test:algo` |
| `npm run smoke` | Çalışan API'ye karşı uçtan uca test (47 kontrol; demo hesap + `DEV_2FA_CODE` gerekir) |

---

## Mimari

```
src/
├─ server.js              giriş: DB kontrolü → piyasa verisi → arka plan işleri → HTTP/WS
├─ app.js                 Fastify, CORS, helmet, rate-limit, hata yönetimi
├─ config.js              ortam değişkenleri (zod ile doğrulanır)
├─ routes/
│  ├─ user.js             /api/v1/*        yatırımcı API'si
│  └─ admin.js            /api/v1/admin/*  yönetim API'si (izin kontrollü)
├─ plugins/auth.js        JWT + DB oturumu, requireAuth / requireTrader / requireAdmin(perm)
├─ services/              auth, exchanges, admin, platform, activity, audit
├─ trading/               orders (emir/defter), engine (koşullu emir, SL/TP), risk, portfolio
├─ automation/            rules (EĞER→O ZAMAN), bots (DCA / Grid / Trailing)
├─ market/                feed (fiyat akışı), depth (mum, emir defteri, işlemler)
├─ exchanges/             providers (katalog), adapters (ccxt, OANDA, generic), health
├─ realtime/              WebSocket hub + /ws
├─ jobs/scheduler.js      periyodik işler
└─ lib/                   prisma, crypto (AES-256-GCM), rbac, tokens, totp, mutex…
prisma/
├─ schema.prisma          21 tablo
├─ migrations/            SQL migration'lar
└─ seed.js                planlar, enstrümanlar, admin, demo
```

### Veri kaynakları — dürüst tablo

| Piyasa | Fiyat | Emir |
|---|---|---|
| Kripto | **Gerçek** – ccxt ile Binance public API (ayarlanabilir). Ulaşılamazsa otomatik simülasyon. | Paper (varsayılan) veya canlı (ccxt; `LIVE_TRADING_ENABLED=true`) |
| Forex | ECB referans kurlarına (frankfurter.app, saatlik) sabitlenmiş simülasyon | Paper |
| BIST | **Simülasyon** – ücretsiz gerçek zamanlı BIST verisi yok; lisanslı veri sağlayıcısı (Matriks, Foreks vb.) gerekir | Paper |

Her ticker'da `source: "live" | "sim"` alanı bulunur; arayüz simüle veriyi etiketler.

### İşlem modları

* **paper** (varsayılan): Gerçek fiyatlarla sanal işlem. Bakiye, pozisyon, komisyon ve K/Z platform defterinde tutulur. API anahtarı olmadan da hesap açılabilir.
* **live**: Emir ccxt ile borsaya gider. Sunucuda `LIVE_TRADING_ENABLED=true` gerekir. Piyasa ve limit emirleri borsaya iletilir; stop / trailing / OCO gibi koşullu emirler platform motoru tarafından izlenip tetiklenince borsaya piyasa emri olarak gönderilir.

### Güvenlik

* Şifreler bcrypt (12 tur); oturumlar JWT + veritabanında iptal edilebilir session.
* Borsa API anahtarları ve 2FA sırları **AES-256-GCM** ile şifreli saklanır, hiçbir yanıtta dönmez (admin dahil).
* Admin hesapları için **TOTP 2FA zorunlu**; platform genelinde kullanıcılar için de zorunlu tutulabilir.
* 5 hatalı girişte hesap risk listesine düşer; giriş uç noktaları dakikada 10 istekle sınırlı.
* Admin hesapları işlem uç noktalarını **kullanamaz** (`ADMIN_NOT_TRADER`); kullanıcı adına emir veremez.
* Her admin yazma işlemi değiştirilemez **denetim günlüğüne** yazılır.
* Kullanıcıya önerilen API anahtarı izinleri: *okuma + işlem*, **para çekme kapalı**, mümkünse IP kısıtlı.

### Roller (RBAC)

| İzin | Süper Admin | Risk | Destek | Finans |
|---|:-:|:-:|:-:|:-:|
| Genel bakış, kullanıcıları görme | ✓ | ✓ | ✓ | ✓ |
| Kullanıcı askıya alma / plan / oturum | ✓ | | ✓ | |
| Kullanıcının işlemlerini durdurma | ✓ | ✓ | | |
| Platform riski, global durdurma | ✓ | ✓ | | |
| Entegrasyonlar | ✓ | ✓ | | |
| Abonelik & ödemeler (görme / yönetme) | ✓ | | | ✓ |
| Duyurular | ✓ | | ✓ | |
| Denetim günlüğü | ✓ | ✓ | | |
| Ekip & roller | ✓ | | | |

### Risk katmanları (emir öncesi sırayla)

1. Platform global durdurma / bakım
2. Kullanıcı hesabı durdurulmuş mu (admin)
3. Kullanıcının kendi acil durdurması (kill switch)
4. Borsa hesabı duraklatılmış / hatalı mı
5. Entegrasyon (borsa) admin tarafından durdurulmuş mu
6. Sembol işleme kapalı mı
7. Kaldıraç ≤ platform limiti, plan vadeli işleme izin veriyor mu
8. Tek emir ≤ platform maks. tutarı
9. Açık emir sayısı ≤ kullanıcı limiti
10. Pozisyon büyüklüğü ≤ portföyün %X'i
11. Bakiye yeterli mi (bekleyen emirlerin kilitlediği tutar düşülerek)
12. Günlük zarar limiti aşılırsa otomatik acil durdurma

### Arka plan işleri

| Sıklık | İş |
|---|---|
| her fiyat (1 sn) | koşullu emirler (limit/stop/stop-limit/trailing/OCO), SL/TP, mum güncelleme |
| 2 sn | emir defteri/işlem yayını, kural motoru |
| 5 sn | botlar, canlı portföy yayını, canlı emir takibi (live açıksa) |
| 10 sn | günlük zarar limiti |
| 1 dk | entegrasyon sağlık kontrolü + olay (incident) kaydı |
| 5 dk | portföy anlık görüntüsü (grafik geçmişi) |
| 10 dk | kullanıcı metrikleri (AUM, 30g hacim) |

> Bu yapı **tek sunucu** içindir. Yatay ölçekleme gerekirse işler ayrı bir worker'a, kilitler ve WS yayını Redis'e taşınmalıdır.

### Abonelik / ödeme

`PAYMENTS_MODE=manual`: Kullanıcı ücretli plan seçince **bekleyen ödeme** oluşur; finans ekibi `POST /admin/payments/:id/confirm` ile onaylayınca plan aktifleşir. Gerçek ödeme sağlayıcısı (iyzico, PayTR, Stripe…) bağlamak için `routes/user.js → /billing/subscribe` içine ödeme oturumu + webhook eklenmelidir.

---

## API özeti

Tüm yanıtlar JSON. Hata: `{ "message": "...", "code": "...", "details": ... }`. Zaman damgaları **ms**.

**Kimlik** – `POST /auth/login` · `POST /auth/2fa` · `POST /auth/register` · `GET|PATCH /auth/me` · `POST /auth/logout` · `POST /auth/change-password` · `POST /auth/2fa/setup|enable|disable` · `POST /auth/forgot-password` · `POST /auth/reset-password` · `POST /auth/verify-email` · `POST /auth/accept-invite` · `GET /auth/sessions` · `DELETE /auth/sessions/:id`

**Yatırımcı** – `GET /providers` · `GET|POST /exchanges` · `POST /exchanges/:id/test` · `PATCH|DELETE /exchanges/:id` · `GET /markets/instruments|tickers|candles|orderbook|trades` · `GET|POST /orders` · `DELETE /orders/:id` · `POST /orders/cancel-all` · `GET /positions` · `POST /positions/:id/close` · `PATCH /positions/:id` · `GET /balances` · `GET /portfolio/summary|history` · `GET|POST /rules` · `PATCH|DELETE /rules/:id` · `GET|POST /bots` · `POST /bots/:id/start|pause|stop` · `DELETE /bots/:id` · `GET|PATCH /risk` · `POST /risk/kill-switch` · `GET /activity` · `GET /announcements/active` · `GET /billing/plans` · `GET /billing/payments` · `POST /billing/subscribe`

**Admin** – `GET /admin/overview` · `GET /admin/users` · `GET|PATCH /admin/users/:id` · `POST /admin/users/:id/logout-all|reset-2fa|resend-verification|notes` · `GET|PATCH /admin/platform` · `POST /admin/platform/kill-switch` · `GET /admin/providers` · `PATCH /admin/providers/:id` · `GET|POST /admin/plans` · `PATCH|DELETE /admin/plans/:id` · `GET /admin/payments` · `POST /admin/payments/:id/refund|confirm|fail` · `GET|POST /admin/announcements` · `PATCH|DELETE /admin/announcements/:id` · `GET /admin/audit` · `GET|POST /admin/team` · `PATCH|DELETE /admin/team/:id`

**Sistem** – `GET /health` · `GET /meta`

**WebSocket** `ws://host/ws?token=<jwt>` → `{"op":"subscribe","channel":"tickers"}`
Kanallar: `tickers`, `orderbook:<SYM>`, `trades:<SYM>`, `candles:<SYM>:<1m|5m|15m|1h|4h|1d>`, kullanıcıya özel `orders`, `positions`, `balances`, `exchanges`, `rules`, `bots`, `risk`, `activity`, `portfolio`.

---

## Canlıya çıkmadan önce kontrol listesi

- [ ] **Yasal:** Türkiye'de kripto varlık hizmet sağlayıcılığı 7518 sayılı Kanun ile SPK lisansına tabi; kullanıcı adına emir ileten bir platform için mutlaka hukuki görüş alın. BIST emir iletimi yalnızca aracı kurum API'si ve sözleşmesiyle mümkündür.
- [ ] `NODE_ENV=production`, güçlü `JWT_SECRET` / `ENCRYPTION_KEY` (yedeğini güvenli yerde saklayın), `DEV_2FA_CODE` boş
- [ ] Admin şifresi değişti, tüm adminlerde 2FA açık
- [ ] HTTPS (reverse proxy: Nginx/Caddy), `CORS_ORIGIN` sadece kendi alan adınız
- [ ] Gerçek e-posta sağlayıcısı (`src/lib/mailer.js`) ve ödeme sağlayıcısı
- [ ] PostgreSQL yedekleme
- [ ] `LIVE_TRADING_ENABLED=true` yapmadan önce borsa **testnet** hesaplarıyla uçtan uca test
