# CLAUDE.md — راهنمای ادامهٔ کار روی بک‌اند بلوک

> این فایل را Claude Code (افزونهٔ VS Code) در شروع هر گفت‌وگو می‌خواند. کوتاه و به‌روز نگهش دار.

## پروژه
بک‌اند **بلوک**: پلتفرم نیروی کار ساختمانی ایران (تمرکز اول: جزیرهٔ قشم). شش نقش شخصی:
`worker` کارگر · `specialist` متخصص · `engineer` مهندس · `contractor` پیمانکار · `company` شرکت ساختمانی · `general` کارفرما.
هر کاربر می‌تواند چند نقش (پروفایل) داشته باشد؛ `users.active_role` نقش فعال است.

- مالک: مجید (پیمانکار، برنامه‌نویس حرفه‌ای نیست). **با او فارسی، کوتاه و مستقیم صحبت کن.** پیش از کار بزرگ، برنامه را کوتاه بگو.
- فرانت (جدا): `mjd7lord-hue/blookblu-front` — یک فایل HTML، فعلاً با دادهٔ نمایشی. منبع حقیقت فرم‌ها و رفتار UI همان است.
- مخزن: `mjd7lord-hue/blookblu`

## پشته
Node 22 · Express 4 · TypeScript (CommonJS) · PostgreSQL روی Supabase · **Drizzle ORM** (نه Prisma — باینری‌های Prisma در ایران/پروکسی مشکل داشت) · Zod 3 · JWT · Vitest + Supertest.
میزبانی: لیارا (`liara.json`). پیامک: کاوه‌نگار یا ملی‌پیامک (`src/lib/sms.ts`).
کد به Supabase وابسته نیست؛ فقط `DATABASE_URL` — اگر از ایران در دسترس نبود، به PostgreSQL لیارا عوض می‌شود.

## دستورها
```bash
npm run dev            # سرور توسعه (tsx watch)
npm run typecheck
npm test               # ۲۶ تست یکپارچه — به PostgreSQL محلی نیاز دارد (پایین)
npm run db:generate    # بعد از تغییر src/db/schema.ts → فایل SQL تازه در drizzle/
npm run db:migrate     # اعمال migrationها روی DATABASE_URL
npm run db:seed        # ۴ کاربر و آگهی نمونه (فقط توسعه)
npm run build && npm start   # start اول migration می‌زند
```
**دیتابیس تست:** `TEST_DATABASE_URL` (پیش‌فرض `postgresql://blook:blook@localhost:5432/blook_test`). تست‌ها schema را پاک می‌کنند — هرگز به دیتابیس اصلی/Supabase وصلش نکن.
روی ویندوز: PostgreSQL را نصب کن یا `docker run -d -p 5432:5432 -e POSTGRES_USER=blook -e POSTGRES_PASSWORD=blook -e POSTGRES_DB=blook_test postgres:16`.

## ساختار
```
src/config/env.ts          متغیرهای محیطی با zod (پیام خطای فارسی)
src/db/schema.ts           همهٔ جدول‌ها (فاز ۱ بالا، فاز ۲ پایین فایل)
src/lib/                   errors, http (ah/parse), text (شماره/فارسی), jwt, sms, events (SSE), flag (ضدکلاهبرداری)
src/middlewares/auth.ts    requireAuth · optionalAuth · requireProfile (req.profile = پروفایل نقش فعال)
src/modules/
  auth/        OTP ۵ رقمی، refresh چرخشی با تشخیص سرقت
  roles/       forms.ts = فرم ثبت‌نام هر نقش (هم‌تراز با REG در فرانت) · validate.ts
  profiles/    /api/me، نقش‌ها، پروفایل عمومی، امتیاز اعتبار (trustOf)
  ads/         آگهی، کاوش، پاسخ به آگهی (خودکار گفت‌وگو می‌سازد)
  chat/        گفت‌وگو، پیام، پیشنهاد توافق/روز شروع، SSE (/api/events)
  projects/    پروژه: توافق→در حال اجرا→تمام/لغو، امتیاز بعد از پایان
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

## وضعیت
- ✅ فاز ۱: OTP، ثبت‌نام ۶ نقش، چندنقشی، پروفایل و مهارت/تعرفه، آگهی و کاوش، پاسخ‌ها، قیم، ذخیره، اعلان، گزارش/مسدودسازی
- ✅ فاز ۲: گفت‌وگو، هشدار کلاهبرداری، پیشنهاد توافق و روز شروع، پروژه‌ها، امتیاز پس از پروژه، SSE
- ⏭ بعدی (به ترتیب پیشنهادی):
  1. آپلود فایل (عکس چت، عکس پروفایل، نمونه‌کار، مدارک) — ذخیره‌سازی سازگار با ایران (مثلاً Object Storage لیارا، S3-compatible)
  2. احراز هویت (KYC) + پنل ادمین (بررسی مدارک، گزارش‌ها، نشان verified)
  3. قرارداد دیجیتال و امضا، مراحل پرداخت، صورت‌وضعیت، گزارش روزانهٔ کارگاه
  4. اتصال فرانت به API
  5. تقویم/رزرو بازدید مهندس، Push (سرویس داخلی مثل نجوا/پوشه)

## گیت
- پیام commit فارسی و توصیفی.
- قبل از commit: `npm run typecheck && npm test`.
- هرگز `.env` را commit نکن.
