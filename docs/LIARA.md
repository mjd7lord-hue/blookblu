# انتقال بلوک به لیارا (داخل ایران) — بدون فیلترشکن

**چرا:** آی‌پی‌های Render/Cloudflare از داخل ایران بسته شده‌اند (آزمایش: `api.blooko.ir` و `blooko.ir` بدون فیلترشکن باز نمی‌شوند). روی لیارا سرور داخل ایران است: بدون فیلترشکن کار می‌کند و درخواست‌ها از حدود ۱٫۲ ثانیه به کسری از ثانیه می‌رسند.

**چه چیزی عوض نمی‌شود:** دامنه‌ها (`blooko.ir`، `api.blooko.ir`، `admin.blooko.ir`)، کد، دیتابیس و فایل‌ها (فعلاً همان Supabase). فقط جای اجرای سرورها و رکوردهای DNS عوض می‌شود.

فایل‌های آماده در مخزن‌ها:

| بخش | پوشه | فایل‌ها |
|---|---|---|
| API | `blookblu` | `liara.json` (Node 22، پورت 3000، نام `blook-api`)، `.liaraignore` |
| اپ | `blookblu-front` | `liara.json` (ایستا، `blook-app`)، `liara_nginx.conf` (لینک دعوت `/i/…`)، `.liaraignore` |
| پنل | `blookblu-admin` | `liara.json` (ایستا، `blook-admin`)، `liara_nginx.conf` (noindex)، `.liaraignore` |

> اگر نام `blook-api` / `blook-app` / `blook-admin` در لیارا گرفته شده بود، نام دیگری بساز و همان را در `liara.json` همان پوشه بنویس.

---

## ۱) حساب و برنامه‌ها
1. در [liara.ir](https://liara.ir) ثبت‌نام کن و کیف پول را شارژ کن.
2. سه برنامه بساز:
   - **NodeJS** با نام `blook-api` — پلن کوچک (۵۱۲ مگابایت حافظه کافی است).
   - **Static** با نام `blook-app`.
   - **Static** با نام `blook-admin`.

## ۲) متغیرهای API (برنامهٔ `blook-api` ← تنظیمات ← متغیرها)
مقدارها را از Render (سرویس `blookblu-api` ← Environment) کپی کن. **JWT ها را همان قبلی بگذار** تا کاربران از حساب بیرون نیفتند.

```
NODE_ENV=production
DATABASE_URL=…            (همان Render)
DIRECT_URL=…              (همان Render)
DB_SSL=true
JWT_ACCESS_SECRET=…       (همان Render)
JWT_REFRESH_SECRET=…      (همان Render)
SMS_PROVIDER=melipayamak
MELIPAYAMAK_USERNAME=…
MELIPAYAMAK_PASSWORD=…
MELIPAYAMAK_BODY_ID=…
MELIPAYAMAK_SIGN_BODY_ID=…   (اگر داری)
MELIPAYAMAK_FROM=…
ALERT_PHONES=…
STORAGE_DRIVER=supabase
SUPABASE_SERVICE_ROLE_KEY=…
CORS_ORIGINS=https://blooko.ir,https://www.blooko.ir,https://admin.blooko.ir
PUBLIC_BASE_URL=https://api.blooko.ir
APP_URL=https://blooko.ir
ZARINPAL_SANDBOX=false
ZARINPAL_MERCHANT=…       (وقتی گرفتی)
ARB_PAYMENT_INFO=…        (اگر داری)
```

## ۳) انتشار (یک بار نصب، بعد با یک دستور)
در CMD یا PowerShell:
```
npm i -g @liara/cli
liara login
```
بعد برای هر بخش (هر خط جدا):
```
cd C:\Users\nininaz\Desktop\block\blookblu
liara deploy
cd C:\Users\nininaz\Desktop\block\blookblu-front
liara deploy
cd C:\Users\nininaz\Desktop\block\blookblu-admin
liara deploy
```
API بعد از نصب، خودش migrationها را اجرا می‌کند (`npm start`) و بالا می‌آید. آزمایش پیش از DNS: آدرس موقت لیارا، مثلاً `https://blook-api.liara.run/api/health` باید `{"ok":true…}` بدهد.

> ابزار ساخت (TypeScript و تایپ‌ها) جزو dependencies است تا ساخت روی لیارا به نصب devDependencies وابسته نباشد.

## ۴) دامنه‌ها
در هر برنامهٔ لیارا ← **دامنه‌ها** ← افزودن:
- `blook-app`: `blooko.ir` و `www.blooko.ir`
- `blook-api`: `api.blooko.ir`
- `blook-admin`: `admin.blooko.ir`

لیارا برای هر دامنه رکورد لازم (CNAME یا A) را نشان می‌دهد. در **Cloudflare ← DNS** همان رکوردها را بگذار و **ابر نارنجی را خاکستری کن (DNS only)**. آی‌پی‌های پروکسی Cloudflare همان‌هایی‌اند که در ایران بسته‌اند. بعد در لیارا گزینهٔ **SSL رایگان** را برای هر دامنه فعال کن.

## ۵) بعد از جابه‌جایی
1. بدون فیلترشکن `https://api.blooko.ir/api/health` و `https://blooko.ir` را باز کن.
2. ورود با پیامک، یک آگهی و پنل ادمین را امتحان کن.
3. در Render سرویس `blookblu-api` و دو سایت ایستا را **Suspend** کن (برگشت‌پذیر؛ چند روز نگه دار، بعد حذف).
4. در گیت‌هاب ← Settings ← Variables، `API_URL` همان `https://api.blooko.ir` می‌ماند (پایش uptime).

## بعداً (اختیاری)
- دیتابیس داخل ایران (دیتابیس PostgreSQL لیارا) تا اپ حتی در قطعی اینترنت بین‌الملل هم کار کند؛ با `pg_dump`/`pg_restore` و عوض کردن `DATABASE_URL`/`DIRECT_URL`.
- فایل‌ها روی Object Storage لیارا: `STORAGE_DRIVER=s3` (درایورش در `lib/storage.ts` آماده است).
