# API بلوک — فاز ۱ تا ۴

همهٔ مسیرها با `/api` شروع می‌شوند. بدنه و پاسخ JSON است.
مسیرهای 🔒 هدر `Authorization: Bearer <accessToken>` می‌خواهند. 👤 یعنی علاوه بر ورود، کاربر باید نقش فعال داشته باشد (کار با پروفایل همان نقش انجام می‌شود).

**قالب خطا** (همیشه یکسان):
```json
{ "error": { "code": "OTP_WRONG", "message": "کد اشتباه است؛ ۴ تلاش دیگر باقی است", "details": { "attemptsLeft": 4 } } }
```
پیام‌ها فارسی و قابل نمایش مستقیم به کاربرند. `code` را برای منطق اپ استفاده کن.

---

## ورود (OTP)

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| POST | `/auth/otp/send` | `{ phone }` | شماره با ارقام فارسی، `+98` یا بدون صفر هم قبول است. پاسخ: `{ sent, expiresIn, resendIn, isNew, devCode? }` |
| POST | `/auth/otp/verify` | `{ phone, code }` | پاسخ: `{ accessToken, refreshToken, isNew, needsRegistration, user }` |
| POST | `/auth/refresh` | `{ refreshToken }` | توکن تازه؛ refresh قبلی باطل می‌شود |
| POST | `/auth/logout` | `{ refreshToken }` | |
| POST | `/auth/logout-all` 🔒 | — | خروج از همهٔ دستگاه‌ها |

کدهای خطای مهم: `OTP_WAIT` (با `retryIn`)، `OTP_LIMIT`، `OTP_WRONG`، `OTP_ATTEMPTS`، `OTP_EXPIRED`، `SMS_FAILED`، `TOKEN_INVALID` (← refresh کن)، `REFRESH_REUSED` (← صفحهٔ ورود).

**اگر `needsRegistration=true` بود** → صفحهٔ انتخاب نقش.

## داده‌های ثابت

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/meta/roles` | تعریف فرم ثبت‌نام هر ۶ نقش (مراحل، فیلدها، گزینه‌ها) |
| GET | `/meta/options` | استان‌ها، سابقه، بازهٔ کار، مخاطب مجاز هر نوع آگهی، دلایل گزارش |
| GET | `/health` | وضعیت سرور و دیتابیس |

## حساب من و نقش‌ها 🔒

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/me` | — | کاربر + همهٔ پروفایل‌های نقش + امتیاز اعتبار هر کدام |
| PATCH | `/me` | `{ prefs: { notif: { requests, messages, ads, reviews }, lang } }` | تنظیمات اعلان و زبان |
| DELETE | `/me` | `{ confirm: "DELETE" }` | حذف حساب |
| POST | `/me/roles` | `{ role, data }` | ثبت نقش؛ `data` همان کلیدهای فرم اپ (`fn`, `ln`, `prov`, `city`, `skills`, ...) |
| PATCH | `/me/roles/:role` | `{ data?, title?, bio? }` | ویرایش جزئی؛ فقط کلیدهای فرستاده‌شده بررسی می‌شوند |
| DELETE | `/me/roles/:role` | — | آخرین نقش را نمی‌شود حذف کرد (`LAST_ROLE`) |
| POST | `/me/active-role` | `{ role }` | تعویض نقش فعال |
| PUT | `/me/roles/:role/week` | `{ week: ["a","o",...] }` | ۷ روز از شنبه؛ `a`=آزاد، `o`=تعطیل. روزهای رزرو (`b`) دست نمی‌خورند |
| PUT | `/me/roles/:role/skills` | `{ skills: [{ title, experience, rateType, rateAmount }] }` | مهارت‌ها و تعرفه‌ها (ویرایش درجا) |
| GET | `/me/profile` | — | پروفایل من همان‌طور که دیگران می‌بینند |

خطای فرم (`ROLE_FORM_INVALID`) خطای هر فیلد را جدا می‌دهد:
```json
{ "details": { "fields": { "skills": "مهارت‌ها لازم است", "exp": "سابقه: یکی از گزینه‌ها را انتخاب کنید" } } }
```

**نقش‌ها:** `worker` کارگر · `specialist` متخصص · `engineer` مهندس · `contractor` پیمانکار · `company` شرکت ساختمانی · `general` کارفرما

## پروفایل‌ها (مهمان هم می‌بیند)

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/profiles?role=&q=&province=&city=&verified=true&available=true&page=&limit=` | جست‌وجوی افراد؛ احرازشده و در دسترس اول |
| GET | `/profiles/:code` | شناسنامهٔ کاری: `avatarUrl`، `portfolio`، مهارت‌ها، اعتبار (`trust`)، ستاره‌ها، نظرها، قیم‌ها، روزهای هفته. شماره فقط با `showPhone` و برای کاربر واردشده |

`trust = { satisfaction(۵۵), projects(۲۵), reviews(۱۰), identity(۱۰), total(۱۰۰) }`

## آگهی‌ها

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/ads?mode=workers\|jobs\|consult&authorRole=&forMe=true&province=&city=&q=&skills=a,b&verified=true&minRating=4&sort=best\|new\|rating\|exp&page=` | کاوش (مهمان هم می‌بیند). `forMe=true` فقط آگهی‌هایی که مخاطبشان نقش فعال من است |
| GET | `/ads/:id` | جزئیات + `isOwn` + `myResponse` |
| GET | `/ads/mine` 👤 | آگهی‌های من (همهٔ وضعیت‌ها) |
| POST | `/ads` 👤 | ثبت آگهی (پایین) |
| PATCH | `/ads/:id` 👤 | ویرایش یا `status: active\|paused\|closed` (فعال‌سازی = تمدید ۳۰ روزه) |
| DELETE | `/ads/:id` 👤 | حذف |

```json
{
  "type": "job",
  "title": "۳ کارگر برای بلوک‌چینی طبقهٔ دوم",
  "description": "کار حدود ۱۰ روز",
  "province": "هرمزگان", "city": "درگهان",
  "wageType": "روزانه", "wageAmount": "۱٬۸۰۰٬۰۰۰",
  "startWhen": "فوری", "range": "city",
  "audience": ["worker"], "needCount": 3, "skills": ["بلوک‌چینی"]
}
```
مخاطب مجاز: `work` → کارفرما/پیمانکار/شرکت · `job` → کارگر/متخصص/مهندس/پیمانکار/شرکت · `consult` → مهندس/متخصص/پیمانکار (حداکثر ۳ گروه).

## پاسخ به آگهی و درخواست‌ها 👤

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| POST | `/ads/:id/responses` | `{ message, offer? }` | نقش فعال باید در مخاطبان آگهی باشد (`NOT_AUDIENCE`) |
| GET | `/ads/:id/responses` | — | پاسخ‌های آگهی من |
| GET | `/responses?dir=in\|out` | — | درخواست‌های ورودی / ارسالی من |
| PATCH | `/responses/:id` | `{ status: accepted\|rejected }` | فقط صاحب آگهی |
| POST | `/responses/:id/withdraw` | — | پس گرفتن درخواست در انتظار |

## اعتبار

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/guarantees` 👤 | — | `mine`: قیم‌های من · `incoming`: کسانی که از من ضمانت خواسته‌اند |
| POST | `/guarantees` 👤 | `{ name, relation, phone }` | درخواست قیم شدن (حداکثر ۵) |
| PATCH | `/guarantees/:id` 🔒 | `{ status: accepted\|rejected }` | فقط صاحب همان شماره |
| DELETE | `/guarantees/:id` 👤 | — | |

امتیاز و نظر از فاز ۲ فقط روی **پروژهٔ تمام‌شده** ثبت می‌شود: `POST /projects/:id/review` (پایین‌تر).

## ذخیره‌ها، اعلان‌ها، ایمنی 🔒

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/saved` | `{ ads, profiles }` |
| PUT / DELETE | `/saved/ad/:id` یا `/saved/profile/:id` | ذخیره / حذف |
| GET | `/notifications?page=` | `{ items, unread }` |
| POST | `/notifications/:id/read` · `/notifications/read-all` | |
| POST | `/reports` | `{ profileCode? , adId?, reason, details? }` |
| GET / POST | `/blocks` | فهرست / `{ profileCode }` |
| DELETE | `/blocks/:code` | رفع مسدودی |

---

# فاز ۲: گفت‌وگو، توافق، پروژه

## گفت‌وگو 🔒

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/conversations?filter=all\|unread\|archived\|project&q=` | — | فهرست؛ `other` (با `avatarUrl`)، `last`، `unread`، `stage` (۰ پیشنهاد، ۱ توافق، ۲ در حال اجرا، ۳ تمام)، `unreadTotal` برای نشان منو |
| POST | `/conversations` 👤 | `{ profileCode, adId? }` | شروع گفت‌وگو با نقش فعال من؛ اگر باشد همان را برمی‌گرداند |
| GET | `/conversations/:id/messages?before=&limit=` | — | پیام‌ها (قدیمی→جدید) + `conversation`، `other`، `project`؛ همزمان «خوانده شد» ثبت می‌شود. `otherLastReadAt` برای تیک دوم |
| POST | `/conversations/:id/messages` | `{kind:'text', body}` · `{kind:'loc', payload:{place,label,lat?,lng?}}` · `{kind:'phone'}` | شماره از حساب خود فرستنده برداشته می‌شود |
| POST | `/conversations/:id/deals` | پایین | پیشنهاد توافق؛ پیشنهاد در انتظارِ قبلی لغو می‌شود |
| POST | `/conversations/:id/days` | `{ date, hour }` | پیشنهاد روز شروع |
| PATCH | `/conversations/:id` | `{ muted?, archived?, pinned? }` | |
| DELETE | `/conversations/:id` | — | پنهان کردن برای من؛ پیام تازه دوباره نشانش می‌دهد |
| POST | `/messages/:id/answer` | `{ status: accepted\|rejected }` | فقط گیرندهٔ پیشنهاد. پذیرش توافق ← پروژه ساخته می‌شود (`{ project }`) |
| POST | `/conversations/:id/attachments` | multipart: `file` + `caption?` | عکس (← `kind:'photo'`) یا PDF (← `kind:'file'`)؛ فاز ۳ |
| DELETE | `/messages/:id` | — | فقط پیام متنی/موقعیت/شماره/عکس/فایلِ خودم تا ۲۴ ساعت؛ به `kind:'del'` تبدیل می‌شود (فایلش هم پاک می‌شود) |

```json
{
  "job": "آرماتوربندی سقف دوم", "qty": "حدود ۳ تن",
  "price": "۹٬۵۰۰٬۰۰۰ تومان هر تن", "amount": "۲۸٬۵۰۰٬۰۰۰",
  "start": "دوشنبه ۶ مهر، ۷ صبح", "durationDays": 3,
  "plan": [{ "title": "پیش‌پرداخت", "pct": 30 }, { "title": "پایان کار", "pct": 70 }],
  "retentionPct": 10
}
```
جمع `plan` باید ۱۰۰ باشد (`PLAN_SUM`). اگر گفت‌وگو پروژهٔ فعال داشته باشد: `PROJECT_ACTIVE`.

**قالب پیام:** `{ id, kind, body, payload, status, flagged, mine, system, projectId, createdAt }`
`kind`: `text` `loc` `phone` `photo` `file` `deal` `day` `sys` `del` (پیام صوتی هنوز نه).
در `photo`/`file`: `body` = توضیح، `payload = { fileId, mime, size, name, url }` — `url` لینک امضاشدهٔ موقت است.
`flagged=true` یعنی پیام درخواست پیش‌پرداخت یا شمارهٔ کارت دارد → هشدار «مراقب باش» برای گیرنده.

**پاسخ به آگهی** حالا خودکار گفت‌وگو می‌سازد: `POST /ads/:id/responses` → `response.conversationId`.

## پروژه‌ها 🔒

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/projects?role=&status=active\|done\|cancelled` | پروژه‌های من؛ `myRole` (client/provider)، `other`، `stageName`، `can` (دکمه‌های مجاز) |
| GET | `/projects/:id` | جزئیات + مراحل پرداخت |
| POST | `/projects/:id/start` | توافق ← در حال اجرا (هر دو طرف) |
| POST | `/projects/:id/finish` | در حال اجرا ← تمام؛ **فقط کارفرما**. +۱ «پروژهٔ انجام‌شده» برای هر دو |
| POST | `/projects/:id/cancel` | `{ reason }` |
| POST | `/projects/:id/review` | `{ rating(1-5), text? }` — فقط پروژهٔ تمام‌شده، هر طرف یک بار |

**کارفرما کیست؟** در آگهی «آمادهٔ همکاری» صاحب آگهی مجری است؛ در «نیاز به نیرو» و «پرسش» صاحب آگهی کارفرماست. در گفت‌وگوی مستقیم: کارفرما > شرکت > پیمانکار > مهندس > متخصص > کارگر.

هر تغییر مرحله، پیام سیستمی در گفت‌وگو و اعلان برای طرف مقابل می‌سازد.

## رویداد لحظه‌ای (SSE)

```js
const es = new EventSource(`${API}/api/events?token=${accessToken}`);
es.addEventListener('message', (e) => { const { conversationId, message } = JSON.parse(e.data); });
es.addEventListener('read', ...);          // طرف مقابل خواند → تیک دوم
es.addEventListener('project', ...);       // پروژه ساخته/عوض شد
es.addEventListener('conversation', ...);  // پیام حذف شد و ...
```
با منقضی شدن توکن، اتصال را با توکن تازه دوباره باز کن.

---

# فاز ۳: فایل‌ها (عکس پروفایل، نمونه‌کار، مدارک، عکس چت)

**آپلود** با `multipart/form-data`، یک فایل در فیلد `file` و فیلدهای متنی کنار آن:
```js
const fd = new FormData();
fd.append('file', input.files[0]);
fd.append('title', 'کاشی حمام واحد ۹۰ متری');
await fetch(`${API}/api/me/roles/specialist/portfolio`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
// Content-Type را دستی نگذار؛ مرورگر boundary را خودش می‌گذارد
```

| نوع | فرمت مجاز | حداکثر | دسترسی |
|---|---|---|---|
| عکس پروفایل، نمونه‌کار | JPG، PNG، WebP | ۵ مگابایت | عمومی |
| مدرک، پیوست چت | JPG، PNG، WebP، PDF | ۱۰ مگابایت | خصوصی (لینک امضاشده) |

نوع فایل از روی **محتوا** تشخیص داده می‌شود نه پسوند. از عکس‌های JPEG اطلاعات EXIF (از جمله مختصات GPS) حذف می‌شود.
بهتر است اپ پیش از آپلود عکس را کوچک کند (مثلاً عرض ۱۶۰۰px، کیفیت ۰٫۸) — سرور تغییر اندازه نمی‌دهد.
خطاها: `NO_FILE`، `FILE_TYPE`، `FILE_TOO_LARGE`، `UPLOAD_INVALID`، `UPLOAD_RATE` (بیش از ۶۰ آپلود در ۱۰ دقیقه).

## دریافت فایل

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/files/:id` | عمومی: آزاد. روی Supabase با `302` به لینک امضاشدهٔ ۱۰ دقیقه‌ای استوریج می‌رود (مرورگر خودش دنبال می‌کند). خصوصی: با `?exp=&sig=` که API داده، یا با توکنِ صاحب فایل / عضو همان گفت‌وگو. در غیر این صورت `404` |

همهٔ پاسخ‌ها فیلد `url`/`avatarUrl` آماده می‌دهند؛ مستقیم در `<img src>` بگذار (نسبی است مگر `PUBLIC_BASE_URL` تنظیم شده باشد → `${API}${url}`).
لینک خصوصی حدود ۱ تا ۲ ساعت اعتبار دارد (`FILE_URL_TTL_SECONDS`)؛ بعد از آن فهرست را دوباره بگیر.

## عکس پروفایل 🔒

| متد | مسیر | توضیح |
|---|---|---|
| PUT | `/me/roles/:role/avatar` | multipart: `file` ← `{ avatarUrl }`. عکس قبلی پاک می‌شود. برای شرکت = لوگو |
| DELETE | `/me/roles/:role/avatar` | |

`avatarUrl` در `/me`، `/profiles`، `/profiles/:code`، نویسندهٔ آگهی و پاسخ‌ها، ذخیره‌ها، گفت‌وگوها و طرفین پروژه هست (`null` = حرف اول نام را نشان بده).

## نمونه‌کار 🔒

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/me/roles/:role/portfolio` | — | `{ items, max: 12 }` |
| POST | `/me/roles/:role/portfolio` | multipart: `file`, `title`, `place?`, `when?` | `when` متن آزاد مثل «مهر ۱۴۰۵». حداکثر ۱۲ (`PORTFOLIO_FULL`) |
| PATCH | `/me/portfolio/:id` | `{ title?, place?, when?, sort? }` (JSON) | |
| DELETE | `/me/portfolio/:id` | — | |

آیتم: `{ id, title, place, when, url, createdAt }` — در پروفایل عمومی زیر `portfolio`.

## مدارک و گواهی‌ها 🔒 (خصوصی)

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/me/documents` | — | مدارک من (همهٔ نقش‌ها) |
| POST | `/me/documents` | multipart: `file`, `title`, `group?`, `role?` | `title` مثل «کارت ملی»، «پروانهٔ اشتغال نظام مهندسی». بدون `role` = مدرک هویتی مشترک. همان عنوانِ در حال بررسی دوباره ← `DOCUMENT_PENDING` |
| DELETE | `/me/documents/:id` | — | مدرک تأییدشده حذف نمی‌شود (`DOCUMENT_APPROVED`) |

مدرک: `{ id, title, group, role, status: pending|approved|rejected, rejectReason, expiresAt, reviewedAt, file: { url, mime, size, name }, createdAt }`.
مدارک هرگز در پروفایل عمومی نمی‌آیند. بررسی و تأیید در پنل ادمین (فاز بعد) انجام می‌شود.

حذف نقش یا حساب، همهٔ فایل‌های مربوط را هم از ذخیره‌ساز پاک می‌کند.

---

# فاز ۴: احراز هویت (KYC) و پنل ادمین

## تأیید هویت 🔒

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/me/kyc` | — | `{ status: none\|pending\|verified\|rejected, request }` — `request.rejectReason` برای نمایش دلیل رد |
| POST | `/me/kyc` | multipart: `card` (روی کارت ملی/کارت اقامت)، `selfie` (سلفی با کارت)، `idType?` (`national`\|`foreign`)، `idNumber?`، `firstName?`، `lastName?` | نام پیش‌فرض از حساب. کد ملی با رقم کنترل بررسی می‌شود |

خطاها: `NO_FILE` (هر دو عکس لازم است)، `NATIONAL_CODE_INVALID`، `ID_NUMBER_INVALID`، `KYC_PENDING`، `KYC_DONE`، `KYC_NAME`.
بعد از تأیید: `identityVerified=true`، ۱۰ امتیاز «احراز هویت» در `trust`، نام قفل می‌شود (`KYC_LOCKED`). **عکس‌های کارت بعد از بررسی (تأیید یا رد) پاک می‌شوند.**
کد ملی هرگز به کاربران دیگر نشان داده نمی‌شود؛ خود کاربر فقط `idNumberMasked` می‌بیند.

**نشان «مدرک‌دار» (`verified`)** = حداقل یک مدرکِ تأییدشده و منقضی‌نشده برای همان نقش. با انقضا خودکار (هر ساعت) برداشته می‌شود.

## پنل ادمین 🛡 (`/admin/*`)

فقط کاربر با `is_admin` (در `/me`: `user.isAdmin`). بقیه: `403 NOT_ADMIN`.
ادمین کردن: کاربر یک بار با OTP وارد شود، بعد در سرور: `npm run admin:grant -- 09121234567` (لغو: `--revoke`).
همهٔ کارها در `/admin/actions` ثبت می‌شوند. لینک عکس‌ها و مدارک امضاشده و موقت است.

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/admin/stats` | — | `{ pending: { kyc, documents, reports }, users: { total, suspended, verified, today } }` |
| GET | `/admin/kyc?status=pending&page=` | — | صف (قدیمی‌ترین اول): نام، کد ملی، `cardUrl`، `selfieUrl`، `user`، `duplicates` (حساب تأییدشدهٔ دیگر با همین کد) |
| POST | `/admin/kyc/:id/approve` | `{ firstName?, lastName?, force? }` | اصلاح نام مطابق کارت. کد ملی تکراری ← `KYC_DUPLICATE` مگر `force:true` |
| POST | `/admin/kyc/:id/reject` | `{ reason }` | کاربر می‌تواند دوباره بفرستد |
| GET | `/admin/documents?status=pending` | — | مدرک + `profile` + `user` + `file.url` |
| POST | `/admin/documents/:id/approve` | `{ expiresAt? }` | تاریخ ISO، مثل `2027-03-20` |
| POST | `/admin/documents/:id/reject` | `{ reason }` | رد یا **لغو تأیید** مدرک تأییدشده |
| GET | `/admin/reports?status=active\|open\|reviewing\|resolved\|dismissed` | — | گزارش + گزارش‌دهنده + `target` (با `reportsCount`) + `ad` |
| PATCH | `/admin/reports/:id` | `{ status: reviewing\|resolved\|dismissed, note? }` | با بستن، به گزارش‌دهنده اعلان می‌رود |
| GET | `/admin/users?q=&status=&kyc=` | — | `q`: شماره (حتی چند رقم آخر)، کد `B-XXXX`، یا نام |
| GET | `/admin/users/:id` | — | کاربر، سابقهٔ KYC، مدارک، گزارش‌های علیه او، کارهای ادمین روی او |
| POST | `/admin/users/:id/suspend` | `{ reason }` | همهٔ نشست‌ها بسته؛ پروفایل و آگهی‌ها پنهان. ادمین/خود ← `TARGET_ADMIN`/`SELF` |
| POST | `/admin/users/:id/unsuspend` | `{ note? }` | |
| POST | `/admin/ads/:id/remove` | `{ reason }` | به صاحب آگهی اعلان می‌رود |
| GET | `/admin/actions?targetId=` | — | ردپای کارهای ادمین |
