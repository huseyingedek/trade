# Tradepilo – Sunucuya Dağıtım

Mimari: **Frontend (Vercel) → Backend (Render, Frankfurt) → PostgreSQL (Neon, Frankfurt)**

> **Bölge neden Frankfurt?** Binance ve Bybit ABD IP'lerinden gelen istekleri engelliyor.
> Backend ABD'de çalışırsa gerçek kripto fiyatları gelmez. Veritabanı da gecikme olmasın
> diye backend ile aynı bölgede olmalı. (Mevcut Neon projeniz ABD-Ohio'da; production için
> Frankfurt'ta yeni bir proje açın. Eskisini geliştirme için kullanmaya devam edebilirsiniz.)

---

## 1) Veritabanı – Neon

1. Neon → **New project** → Region: **AWS Europe Central 1 (Frankfurt)** → Postgres 17/18.
2. **Connect** → *Connection pooling* **kapalı** → bağlantı adresini kopyalayın.
3. Adresin sonundaki `&channel_binding=require` kısmını silin:
   `postgresql://neondb_owner:ŞİFRE@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`

Tabloları ve başlangıç verisini backend ilk açılışta kendisi oluşturur (`npm run start:prod`).

## 2) E-posta – Resend (şifre sıfırlama için şart)

1. https://resend.com → hesap açın → **Domains** → alan adınızı ekleyip DNS kayıtlarını girin.
2. **API Keys** → yeni anahtar oluşturun.
3. Gönderen adres doğrulanmış alan adınızdan olmalı: `Tradepilo <no-reply@alanadiniz.com>`

E-posta bağlanmazsa: kullanıcılar şifrelerini unuttuklarında sıfırlayamaz.

## 3) Backend – Render

1. `tradenest-api` klasörünü bir GitHub reposuna gönderin (`.env` gitignore'da, gitmez).
2. Render → **New → Blueprint** → repoyu seçin. `render.yaml` her şeyi hazırlar
   (Frankfurt, starter plan, tek instance, sağlık kontrolü).
3. İstenen ortam değişkenlerini girin:

| Değişken | Değer |
|---|---|
| `DATABASE_URL` | 1. adımdaki Neon adresi |
| `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` çıktısı – **güvenli bir yerde yedekleyin**, kaybolursa kayıtlı API anahtarları ve 2FA sırları çözülemez |
| `CORS_ORIGIN` | frontend adresi, örn. `https://tradenest.vercel.app` (sonda `/` yok) |
| `APP_URL` | aynı frontend adresi (e-postalardaki bağlantılar için) |
| `RESEND_API_KEY` | 2. adımdaki anahtar |
| `SMTP_FROM` | `Tradepilo <no-reply@alanadiniz.com>` |
| `SEED_ADMIN_EMAIL` | kendi e-postanız |
| `SEED_ADMIN_PASSWORD` | güçlü bir şifre (en az 12 karakter) |

`JWT_SECRET` otomatik üretilir. `LIVE_TRADING_ENABLED=false`, `PAYMENTS_MODE=disabled`, `SEED_DEMO=false` hazır gelir.

4. Deploy bitince loglarda şunları görmelisiniz:
   - `✅ Seed tamam`
   - `✅ Production kontrolleri temiz` (uyarı varsa listelenir – hepsini giderin)
   - `✅ Gerçek kripto fiyatları alınıyor (binance)`
5. Test: `https://<servis>.onrender.com/api/v1/health` → `{"ok":true,...}`

> **Ücretsiz Render planı kullanmayın:** 15 dk boşta kalınca uyur; emir motoru, botlar ve
> kurallar durur. Instance sayısını 1'den fazla yapmayın (arka plan işleri tek süreç için tasarlandı).

## 4) Frontend – Vercel

1. `hirenest-admin` klasörünü ayrı bir GitHub reposuna gönderin.
2. Vercel → **Add New → Project** → repoyu seçin (Framework: Vite – otomatik algılanır).
3. **Environment Variables** (build sırasında okunur – değiştirirseniz yeniden deploy edin):

| Değişken | Değer |
|---|---|
| `VITE_USE_MOCK` | `false` |
| `VITE_API_URL` | `https://<servis>.onrender.com/api/v1` |
| `VITE_WS_URL` | `wss://<servis>.onrender.com/ws` (**wss**, ws değil) |

4. Deploy bitince Vercel adresini Render'da `CORS_ORIGIN` ve `APP_URL` olarak girin → Render yeniden başlar.

## 5) İlk giriş ve yayına alma

1. Frontend adresinden `SEED_ADMIN_EMAIL` ile giriş yapın → QR kodu Authenticator ile okutun.
2. Admin → **Abonelik & Ödemeler → Planlar**: deneme sürecinde Ücretsiz planın limitlerini
   (1 borsa / 1 bot / 3 kural) artırmak isteyebilirsiniz.
3. Admin → **Duyurular**: kullanıcılara hoş geldin / deneme sürümü duyurusu yayınlayın.
4. Kendi test kullanıcınızla kayıt olun, sanal hesap açın, bir emir verin, şifremi unuttum e-postasını deneyin.

## Kontrol listesi

- [ ] Neon production projesi **Frankfurt**'ta, bağlantı havuzsuz
- [ ] Geliştirme veritabanının sohbette paylaşılan şifresi sıfırlandı (Neon → Roles → Reset password)
- [ ] `ENCRYPTION_KEY` yedeklendi
- [ ] Render loglarında production uyarısı yok
- [ ] Resend çalışıyor (şifremi unuttum e-postası geldi)
- [ ] `CORS_ORIGIN` / `APP_URL` gerçek frontend adresi
- [ ] Admin 2FA kuruldu, admin şifresi güçlü
- [ ] `LIVE_TRADING_ENABLED=false` (gerçek emir yok)
- [ ] **Hukuki:** KVKK aydınlatma metni ve kullanım koşulları hazır, kayıt sayfasından bağlantı verildi
  (veriler yurt dışındaki sunucularda – Neon/Render/Vercel/Resend – tutuluyor; KVKK'nın yurt dışına
  aktarım şartları için hukuki görüş alın). Gerçek emir iletimine geçmeden önce SPK (7518 sayılı Kanun) değerlendirmesi.

## Maliyet (yaklaşık, güncel fiyatları kontrol edin)

- Render Starter: aylık ~7 USD
- Neon: backend sürekli sorgu attığı için veritabanı uykuya geçmez; Launch planında
  0,25 CU sürekli çalışma aylık birkaç on dolar tutabilir. Computes ayarından üst sınırı 1 CU yapın.
- Resend ücretsiz katmanı deneme için yeterli.
- Vercel Hobby planı kişisel/ticari olmayan kullanım içindir; ücretli abonelik satmaya başladığınızda Pro plan gerekir.
