# CLAUDE.md — راهنمای ادامهٔ کار روی بک‌اند بلوک

> این فایل را Claude Code (افزونهٔ VS Code) در شروع هر گفت‌وگو می‌خواند. کوتاه و به‌روز نگهش دار.

## پروژه
بک‌اند **بلوک**: پلتفرم نیروی کار ساختمانی ایران (تمرکز اول: جزیرهٔ قشم). شش نقش شخصی:
`worker` کارگر · `specialist` متخصص · `engineer` مهندس · `contractor` پیمانکار · `company` شرکت ساختمانی · `general` کارفرما.
هر کاربر می‌تواند چند نقش (پروفایل) داشته باشد؛ `users.active_role` نقش فعال است.

- مالک: مجید (پیمانکار، برنامه‌نویس حرفه‌ای نیست). **با او فارسی، کوتاه و مستقیم صحبت کن.** پیش از کار بزرگ، برنامه را کوتاه بگو.
- فرانت (جدا): `mjd7lord-hue/blookblu-front` (کنار این پوشه: `Desktoplookblu-front`) — `index.html` (کل اپ با دادهٔ نمایشی؛ منبع حقیقت فرم‌ها و UI) + `live.js` (اتصال به API).
  روش اتصال: `live.js` تابع‌های نمایشی را wrap می‌کند و دادهٔ API را به همان شکل‌های `P` (افراد، کلید = کد B-XXXX)، `ADS`، `S.convs`، `S.notifs` درمی‌آورد؛ بدون سرور اپ نمایشی می‌ماند. آدرس API: `?api=...` یا پیش‌فرض localhost:3000 روی فایل محلی.
- مخزن: `mjd7lord-hue/blookblu`

## پشته
Node 22 · Express 4 · TypeScript (CommonJS) · PostgreSQL روی Supabase · **Drizzle ORM** (نه Prisma — باینری‌های Prisma در ایران/پروکسی مشکل داشت) · Zod 3 · JWT · Vitest + Supertest.
**فعلاً همه‌چیز روی Supabase است، نه لیارا** (به تصمیم مجید): دیتابیس + ذخیرهٔ فایل (Supabase Storage، باکت خصوصی `blook-files`). `liara.json` و درایور `s3` برای بعد نگه داشته شده‌اند. پیامک: کاوه‌نگار یا ملی‌پیامک (`src/lib/sms.ts`).
کد به Supabase قفل نیست: دیتابیس فقط `DATABASE_URL`/`DIRECT_URL`، فایل از `lib/storage.ts` با `STORAGE_DRIVER` (auto|supabase|local|s3).
- اپ با Transaction pooler (6543) و migration با `DIRECT_URL` (Session pooler، 5432).
- `db:migrate` بعد از هر migration روی همهٔ جدول‌های public RLS را روشن و دسترسی `anon`/`authenticated` را می‌گیرد (وگرنه REST API خود Supabase با کلید عمومی همه‌چیز را لو می‌دهد). بک‌اند با نقش postgres (bypass RLS) کار می‌کند؛ policy لازم نیست.

## دستورها
```bash
npm run dev            # سرور توسعه (tsx watch)
npm run typecheck
npm run test:db        # PostgreSQL تست قابل‌حمل (بدون Docker) روی 5432 روشن می‌کند؛ خاموش: npm run test:db -- stop
npm test               # ۴۵ تست یکپارچه — به PostgreSQL محلی نیاز دارد (پایین)
npm run db:generate    # بعد از تغییر src/db/schema.ts → فایل SQL تازه در drizzle/
npm run db:migrate     # اعمال migrationها روی DIRECT_URL (یا DATABASE_URL) + قفل RLS
npm run storage:check  # آزمایش ذخیرهٔ فایل (آپلود/لینک/حذف) با تنظیمات .env
npm run admin:grant -- 09xxxxxxxxx   # ادمین کردن کاربر (لغو: --revoke)
npm run sms:test -- 09xxxxxxxxx      # آزمایش پنل پیامک (ملی‌پیامک) با تنظیمات .env
npm run front:smoke    # فرانت (../blookblu-front) در jsdom در برابر همین API روی دیتابیس تست — بعد از هر تغییر live.js
npm run db:seed        # ۴ کاربر و آگهی نمونه (فقط توسعه)
npm run build && npm start   # start اول migration می‌زند
```
**دیتابیس تست:** `TEST_DATABASE_URL` (پیش‌فرض `postgresql://blook:blook@localhost:5432/blook_test`). تست‌ها schema را پاک می‌کنند — هرگز به دیتابیس اصلی/Supabase وصلش نکن.
روی ویندوز ساده‌ترین راه `npm run test:db` است (باینری از بستهٔ embedded-postgres، دادهٔ `.pgdata/`، دیتابیس UTF8). یا PostgreSQL را نصب کن یا `docker run -d -p 5432:5432 -e POSTGRES_USER=blook -e POSTGRES_PASSWORD=blook -e POSTGRES_DB=blook_test postgres:16`.

## ساختار
```
src/config/env.ts          متغیرهای محیطی با zod (پیام خطای فارسی)
src/db/schema.ts           همهٔ جدول‌ها (فاز ۱ بالا، فاز ۲ پایین فایل)
src/lib/                   errors, http (ah/parse), text (شماره/فارسی), jwt, sms, events (SSE), flag (ضدکلاهبرداری), storage (supabase/local/s3)
src/middlewares/auth.ts    requireAuth · optionalAuth · requireProfile (req.profile = پروفایل نقش فعال) · requireAdmin
src/modules/
  auth/        OTP ۵ رقمی، refresh چرخشی با تشخیص سرقت
  roles/       forms.ts = فرم ثبت‌نام هر نقش (هم‌تراز با REG در فرانت) · validate.ts
  profiles/    /api/me، نقش‌ها، پروفایل عمومی، امتیاز اعتبار (trustOf)
  ads/         آگهی، کاوش، پاسخ به آگهی (خودکار گفت‌وگو می‌سازد)
  chat/        گفت‌وگو، پیام، پیشنهاد توافق/روز شروع، SSE (/api/events)
  projects/    پروژه: توافق→در حال اجرا→تمام/لغو، امتیاز بعد از پایان · access.ts (projectFor: من کدام طرفم)
               payments (دفترچهٔ پرداخت دوطرفه) · statements (صورت‌وضعیت) · worksite (گزارش روزانه، فایل پروژه)
  contracts/   قرارداد دیجیتال: متن از توافق، هش متن، امضا با کد پیامکی (purpose=sign)، نسخهٔ چاپی HTML
  files/       آپلود (multer در حافظه، فیلد file)، تشخیص نوع از محتوا، حذف EXIF، لینک امضاشده؛ عکس پروفایل، نمونه‌کار، مدارک
  kyc/         تأیید هویت (/api/me/kyc): کارت + سلفی، کد ملی با رقم کنترل؛ عکس‌ها بعد از بررسی پاک
  admin/       پنل ادمین (/api/admin): صف KYC و مدارک، گزارش‌ها، مسدودسازی، حذف آگهی، ردپا (admin_actions)، recomputeVerified
  arbitration/ حل اختلاف و داوری حضوری: fees.ts (فرمول هزینه = هم‌تراز ARB_F/arbFee فرانت) · candidates (بی‌طرفی: بدون گفت‌وگو/پروژهٔ مشترک)
               پرونده: open → arbitration → decided/settled · دور داوری: awaiting_payment → matching → offered → assigned → reported → final (+ بازبینی round=2)
  trust/ saved/ notifications/ safety/
docs/API.md    مرجع کامل API — با هر تغییر مسیر، به‌روزش کن
```

## قواعد کد (رعایت کن)
- **پیام خطا همیشه فارسی و قابل نمایش به کاربر**؛ با `badRequest/forbidden/notFound/conflict` از `lib/errors` و یک `code` انگلیسی ثابت (اپ روی `code` تصمیم می‌گیرد).
- ورودی همیشه با `parse(zodSchema, ...)` از `lib/http`؛ route async داخل `ah(...)`.
- **ارقام فارسی را در متن ذخیره‌شده تبدیل نکن** (`normalizeFa` فقط ي/ك و فاصله را یکسان می‌کند). گزینه‌های فرم مثل «۵ تا ۱۰ سال» و نیم‌فاصله (مثل «بتن‌ریزی») باید دست‌نخورده بمانند. برای عدد/شناسه از `toLatinDigits` استفاده کن.
- شماره موبایل همیشه با `normalizePhone` → `09xxxxxxxxx`.
- دادهٔ خصوصی (مدرک اقامت اتباع، شناسهٔ ملی شرکت، بودجه) هرگز در پروفایل عمومی نیاید — فیلد را در `forms.ts` با `private: true` علامت بزن.
- تغییر schema = `npm run db:generate` و commit فایل‌های `drizzle/`. migrationهای قبلی را ویرایش نکن.
- هر قابلیت تازه = تست یکپارچه در `tests/`. نکته: درخواست supertest تنبل است؛ بدون `await`/`.then` اجرا نمی‌شود.
- فرمول امتیاز اعتبار (۵۵ رضایت + ۲۵ پروژه + ۱۰ تعداد نظر + ۱۰ احراز هویت) باید با فرانت یکی بماند.
- رویداد لحظه‌ای درون‌حافظه است (`lib/events.ts`)؛ اگر لیارا چند نمونه شد → Redis.
- کد پیامکی همیشه با `purpose` (`login` یا `sign` + ctx) — کد یک کاربرد برای دیگری قبول نمی‌شود. امضای قرارداد به `contentHash` (canonicalJson متن) گره خورده؛ هر ویرایش = نسخهٔ تازه.
- مبلغ‌ها عدد صحیح تومان؛ ورودی مبلغ با `moneyInput` از `lib/http` (ارقام فارسی و ٬ قبول).
- داوری: فرمول هزینه، حوزه‌ها و متن مادهٔ ۷ قرارداد باید با فرانت (دور ۲۵) یکی بماند. پرداخت امانی فعلاً دستی (ادمین `confirm-payment`)؛ درگاه بانکی بعداً.
- هر کار ادمین = یک ردیف در `admin_actions` (تابع `adminLog` در admin.service). ادمین فقط با اسکریپت ساخته می‌شود، نه API.
- فایل: همیشه با `saveUpload` از `modules/files/files.service` (نوع و حجم را همان‌جا چک می‌کند) و حذف با `purgeFiles` (ردیف + خود فایل). فایل خصوصی فقط با `fileUrl` (لینک امضاشده) به کسی داده شود که اجازه دارد. کلید `SUPABASE_SERVICE_ROLE_KEY` فقط در `.env` بک‌اند؛ هرگز در فرانت.

## وضعیت
- ✅ فاز ۱: OTP، ثبت‌نام ۶ نقش، چندنقشی، پروفایل و مهارت/تعرفه، آگهی و کاوش، پاسخ‌ها، قیم، ذخیره، اعلان، گزارش/مسدودسازی
- ✅ فاز ۲: گفت‌وگو، هشدار کلاهبرداری، پیشنهاد توافق و روز شروع، پروژه‌ها، امتیاز پس از پروژه، SSE
- ✅ فاز ۳: آپلود فایل — عکس پروفایل، نمونه‌کار (۱۲ تا)، مدارک خصوصی (pending/approved/rejected)، عکس/PDF در چت؛ ذخیره در Supabase Storage (یا local در توسعه)
- ✅ فاز ۴: KYC (نشان هویت + ۱۰ امتیاز، قفل نام، تشخیص کد ملی تکراری) و API پنل ادمین (مدارک و نشان مدرک‌دار با انقضا، گزارش‌ها، مسدودسازی، ردپا). رابط گرافیکی پنل هنوز ساخته نشده
- ✅ فاز ۵: قرارداد دیجیتال (امضای پیامکی روی هش متن، نسخه‌بندی، چاپ)، دفترچهٔ پرداخت با تأیید طرف مقابل، صورت‌وضعیت با کسورات و اصلاح کارفرما، گزارش روزانه با عکس، فایل پروژه
- ✅ فاز ۶ (بخش ۱): اتصال فرانت — ورود پیامکی، ثبت‌نام/نقش‌ها، پروفایل، کاوش و آگهی، پاسخ، چت کامل با SSE، اعلان‌ها، KYC، تنظیمات، خروج/حذف حساب
- ✅ فاز ۷: حل اختلاف و داوری حضوری (بک‌اند) — ثبت اختلاف، ۴۸ ساعت گفت‌وگو، هزینه و کمیسیون، پرداخت امانی دستی، حل‌کنندهٔ بی‌طرف و حق رد، گزارش با عکس، اعتراض و بازبینی، آزاد شدن سهم، امتیاز حل‌کننده؛ درخواست حل‌کنندگی مهندس/متخصص و بررسی ادمین
- ✅ فاز ۶ (بخش ۲): `live-projects.js` — پروژه‌ها، قرارداد و امضای پیامکی، پرداخت، صورت‌وضعیت، گزارش روزانه، فایل پروژه، حل اختلاف و داوری (هر دو طرف و حل‌کننده)، مدارک، نمونه‌کار، عکس پروفایل. `front:smoke` همهٔ این مسیرها را با سه کاربر می‌آزماید
- ⏭ بعدی (به ترتیب پیشنهادی):
  4. اتصال فرانت بخش ۳: ذخیره‌ها، آگهی‌های من و پاسخ‌ها (پذیرش/رد)، مرکز درخواست‌ها، تقویم؛ محتوای خانهٔ هر نقش از دادهٔ واقعی
  - درگاه پرداخت (زرین‌پال یا مشابه) برای هزینهٔ داوری — نیاز به حساب پذیرنده
  - میزبانی API (فعلاً فقط روی کامپیوتر خود مجید؛ لیارا کنار گذاشته شده)
  - صفحهٔ گرافیکی پنل ادمین (API آماده است)
  - تیم و حضور و غیاب — در فرانت نمایشی هست
  5. تقویم/رزرو بازدید مهندس، Push (سرویس داخلی مثل نجوا/پوشه)

## گیت
- پیام commit فارسی و توصیفی.
- قبل از commit: `npm run typecheck && npm test`.
- هرگز `.env` را commit نکن.
