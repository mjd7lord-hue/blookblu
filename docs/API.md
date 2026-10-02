# API بلوک — فاز ۱ تا ۷

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
| GET | `/profiles?role=&q=&province=&city=&verified=true&available=true&page=&limit=` | جست‌وجوی افراد؛ احرازشده و در دسترس اول. `q` = بخشی از نام/عنوان/مهارت یا کد کاربری (`b4x92`، `B-4X92`، `4X92` همه یکی) |
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

**آگهی رایگان:** هر کاربر (در همهٔ نقش‌هایش) حداکثر `limits.freeAds` (پیش‌فرض ۱ = `FREE_AD_LIMIT` اپ) آگهی `work`/`job` فعال دارد؛ بیشتر ← `409 FREE_AD_LIMIT`. پرسش تخصصی محدود نیست. سقف کلی ۲۰ آگهی فعال برای هر پروفایل.

## پاسخ به آگهی و درخواست‌ها 👤

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| POST | `/ads/:id/responses` | `{ message, offer? }` | نقش فعال باید در مخاطبان آگهی باشد (`NOT_AUDIENCE`)؛ به پرسش تخصصی همه پاسخ می‌دهند |
| GET | `/ads/:id/answers` | — | پاسخ‌های عمومی پرسش: `up`، `down`، `score`، `myVote` (با ورود)؛ مرتب بر اساس امتیاز |
| POST | `/responses/:id/vote` 🔒 | `{ value: 1\|-1\|0 }` | مفید بود / نبود / برداشتن رأی (نه به پاسخ خودت: `OWN_ANSWER`) |
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
| GET | `/projects?role=&status=active\|done\|cancelled` | پروژه‌های من؛ `myRole` (client/provider)، `other`، `stageName`، `myRating` (ستاره‌ای که من داده‌ام یا null)، `can` (دکمه‌های مجاز) |
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
ادمین کردن در سرور: `npm run admin:grant -- 09121234567` (اگر حساب نباشد ساخته می‌شود؛ لغو: `--revoke`).
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

---

# فاز ۵: قرارداد، دفترچهٔ پرداخت، صورت‌وضعیت، گزارش روزانه 🔒

همه فقط برای **دو طرف پروژه** (کارفرما و مجری)؛ بقیه `404`. روی پروژهٔ لغوشده/تمام‌شده، ثبت تازه ← `PROJECT_CLOSED`.
`mySide` / `side`: `client` (کارفرما) یا `provider` (مجری). هر پاسخ `can` دارد = دکمه‌های مجاز برای همین کاربر.

## قرارداد دیجیتال

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/projects/:id/contract` | — | اولین بار از توافق چت پیش‌نویس می‌سازد (شمارهٔ `BLK-1405-000123`) |
| PATCH | `/projects/:id/contract` | `{ milestones?, durationDays?, retentionPct?, retentionMonths?, delayPenaltyPct?, extraClauses? }` | هر طرف. **نسخهٔ تازه = امضاهای قبلی باطل** و به طرف مقابل اعلان می‌رود. قرارداد فعال ← `CONTRACT_LOCKED` |
| POST | `/projects/:id/contract/sign-code` | — | کد ۵ رقمی به موبایل خود امضاکننده پیامک می‌شود. پاسخ: `{ contentHash, expiresIn, devCode? }` |
| POST | `/projects/:id/contract/sign` | `{ code, contentHash }` | `contentHash` همان متنی که کاربر دیده؛ اگر عوض شده ← `CONTRACT_CHANGED` |
| GET | `/contracts/:id/print?exp=&sig=` | — | صفحهٔ چاپی (HTML) — لینکش `printUrl` در پاسخ قرارداد است؛ در مرورگر «چاپ → ذخیره به PDF» |

قرارداد: `{ id, number, version, status: draft|signing|active|void, statusName, contentHash, terms, signatures: { client, provider }, can: { edit, sign, remind }, printUrl }`.
`terms.clauses` = متن ۷ ماده (+ «شرایط خاص» از `extraClauses`) آمادهٔ نمایش؛ `terms.milestones`، `retentionPct`، ... برای فرم ویرایش.
کد امضا فقط برای همان قرارداد و همان نسخه معتبر است (کد ورود یا کد قرارداد دیگر قبول نیست). با دو امضا ← `active`، پیام سیستمی در چت و اعلان.
لغو پروژه ← قرارداد امضانشده `void`. در `GET /projects/:id` فیلد `contract: { status, number } | null`.
الگوی پیامک جدا برای امضا (اختیاری): `MELIPAYAMAK_SIGN_BODY_ID` یا `KAVENEGAR_SIGN_TEMPLATE`.

## دفترچهٔ پرداخت

بلوک پولی جابه‌جا نمی‌کند؛ هر طرف پرداخت را **ثبت** می‌کند و **طرف مقابل** تأیید یا اعتراض می‌کند.

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/projects/:id/payments` | — | `{ items, summary, labels }` |
| POST | `/projects/:id/payments` | `{ amount, label, milestoneIndex?, statementId?, paidOn?, note? }` | `amount` عدد یا «۸٬۵۵۰٬۰۰۰». `label` یکی از `labels`. `paidOn` مثل `2026-09-28` (پیش‌فرض امروز) |
| POST | `/payments/:id/confirm` | — | فقط طرف مقابلِ ثبت‌کننده (`OWN_PAYMENT`) |
| POST | `/payments/:id/dispute` | `{ reason }` | |
| DELETE | `/payments/:id` | — | فقط ثبت‌کننده و تا تأیید نشده |

`summary = { total, confirmed, pending, disputed, remaining, retention, milestones: [{ index, title, pct, due, paid }] }`.

## صورت‌وضعیت (متره × فی)

مجری تنظیم و ارسال می‌کند، کارفرما تأیید یا رد. فقط یک صورت‌وضعیت باز در هر زمان (`STATEMENT_OPEN`).

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/projects/:id/statements` | — | فهرست + `nextBase` (ردیف‌های پیشنهادی بعدی) |
| POST | `/projects/:id/statements` | `{ items?, retentionPct?, insurancePct?, note? }` | فقط مجری. بدون `items` = ردیف‌های آخرین صورت‌وضعیت تأییدشده |
| GET / PATCH | `/statements/:id` | همان بدنه | ویرایش فقط در `draft`/`rejected` |
| POST | `/statements/:id/send` | — | کار این دوره باید بیشتر از صفر باشد (`NOTHING_TO_BILL`) |
| POST | `/statements/:id/approve` | `{ adjust?: [{ key, done }] }` | کارفرما؛ می‌تواند مقدار را **کم** کند (بین «قبلی» و ادعای مجری) |
| POST | `/statements/:id/reject` | `{ reason }` | مجری اصلاح می‌کند و دوباره می‌فرستد |
| DELETE | `/statements/:id` | — | پیش‌نویس/ردشده |

ردیف: `{ key, title, unit, qty, unitPrice, prevDone, done }` — `done` تجمعی (تا امروز). `key` را در ویرایش برگردان؛ ردیف بی‌`key` = ردیف تازه.
`prevDone` از آخرین صورت‌وضعیت تأییدشده می‌آید و کمتر از آن نمی‌شود (`ROW_BELOW_PREV`)؛ `done > qty` ← `DONE_OVER_QTY`.
`totals = { contractValue, doneValue, prevValue, periodValue, retention, insurance, payable, progressPct }` — کسر حسن انجام کار (پیش‌فرض از قرارداد) و بیمه (`insurancePct`، پیش‌فرض ۰) از کار همین دوره.
پرداخت صورت‌وضعیت: `POST /projects/:id/payments` با `statementId` (فقط تأییدشده).

## گزارش روزانهٔ کارگاه

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/projects/:id/daily?before=&limit=` | — | تازه‌ترین اول + `stats: { days, crewDays }` |
| POST | `/projects/:id/daily` | multipart: `done`, `crew?`, `weather?`, `issues?`, `date?` + تا ۴ عکس در `photos` — یا JSON | هر طرف، روزی یک گزارش (`DAILY_EXISTS` با `details.id` برای ویرایش) |
| PATCH | `/daily/:id` | `{ weather?, crew?, done?, issues? }` | فقط نویسنده |
| DELETE | `/daily/:id` | — | عکس‌ها هم پاک می‌شوند |

## فایل‌های پروژه

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/projects/:id/files` | نقشه، صورت‌جلسه، ... (عکس‌های گزارش روزانه جدا) — حداکثر ۵۰ |
| POST | `/projects/:id/files` | multipart: `file` (عکس یا PDF، ۱۰ مگابایت) |
| DELETE | `/projects/:id/files/:fileId` | فقط کسی که گذاشته |

رویدادهای لحظه‌ای تازه (SSE): `contract`، `payment`، `statement`، `daily`، `notification` (هر اعلان تازه).

---

# فاز ۷: حل اختلاف و داوری حضوری

مسیر (هم‌تراز با فرانت، دور ۲۵): ثبت اختلاف ← ۴۸ ساعت گفت‌وگو ← درخواست حل‌کننده و **پرداخت امانی** ← حل‌کنندهٔ بی‌طرف همان حوزه ←
بازدید و گزارش (حداقل ۳ عکس) و رأی ← ۷۲ ساعت مهلت اعتراض (بازبینی با حل‌کنندهٔ دوم، نصف هزینه، رأی نهایی) ← آزاد شدن سهم حل‌کننده.
مادهٔ ۷ قرارداد = موافقت‌نامهٔ داوری.

**هزینه** (`GET /disputes/meta` همهٔ ضریب‌ها را می‌دهد): پایه ۱٬۲۰۰٬۰۰۰ × ضریب حوزه × ضریب مبلغ (گرد به ۱۰ هزار) + رفت‌وآمد
(حل‌کننده در همان شهر: ۰، همان استان: ۶۰۰٬۰۰۰، استان دیگر: ۲٬۰۰۰٬۰۰۰). کمیسیون بلوک ۱۵٪، یا ۲۰٪ برای پروندهٔ پیچیده (مبلغ بالای ۲۰۰ میلیون، حوزهٔ سازه، یا چند موضوع). سهم حل‌کننده = بقیه + رفت‌وآمد.
**پرداخت فعلاً دستی است:** بعد از درخواست، پاسخ `payment.instructions` دارد (از `ARB_PAYMENT_INFO` در `.env`)؛ ادمین پرداخت را تأیید می‌کند.

**بی‌طرفی:** حل‌کننده باید با هیچ‌کدام از دو طرف گفت‌وگو یا پروژهٔ مشترک نداشته باشد؛ محدودهٔ بازدیدش (`city`/`province`/`neighbors`) باید شامل محل باشد.
اول هم‌شهر، بعد هم‌استان، بعد کم‌کارتر و بهتر. حل‌کننده تا قبول نکرده به طرفین معرفی نمی‌شود.

## طرفین اختلاف 🔒

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/disputes/meta` | — | موضوع‌ها، درخواست‌ها، مراحل، حوزه‌ها، فرمول هزینه (مهمان هم) |
| POST | `/projects/:id/disputes` | `{ reason, ask, description, city? }` | هر طرف پروژه؛ یک پروندهٔ باز برای هر پروژه (`DISPUTE_OPEN`). محل پیش‌فرض: شهر ثبت‌کننده |
| GET | `/disputes` | — | پرونده‌های من (ثبت‌کرده یا علیه من) |
| GET | `/disputes/:id` | — | پرونده + `case` (دور فعلی) + `history` + `stage` (۰ تا ۴، هم‌تراز با DSTG2) + `can` |
| POST | `/disputes/:id/settle` | — | «توافق کردیم»؛ فقط پیش از پرداخت (`ARB_IN_PROGRESS`) |
| GET | `/disputes/:id/quote?field=&amountMillion=&multi=` | — | پیش‌نمایش هزینه + `available` (تعداد حل‌کنندهٔ بی‌طرف در دسترس) |
| POST | `/disputes/:id/arbitration` | `{ field, amountMillion, multi?, agree: true }` | فقط ثبت‌کننده، بعد از ۴۸ ساعت (`TALK_WINDOW` با `hoursLeft`) ← `{ dispute, payment }` |
| POST | `/disputes/:id/reject-arbiter` | — | هر طرف یک بار (`REJECT_USED`)؛ حل‌کنندهٔ دیگری تعیین می‌شود |
| POST | `/disputes/:id/appeal` | `{ reason }` | فقط به رأی دور اول و در ۷۲ ساعت ← دور بازبینی با نصف هزینه ← `{ dispute, payment }` |
| POST | `/disputes/:id/accept` | — | قبول رأی؛ با قبول **هر دو** طرف زودتر نهایی می‌شود، وگرنه بعد از مهلت اعتراض خودکار |
| POST | `/disputes/:id/rate` | `{ rating(1-5), impartial }` | بعد از بسته شدن با رأی؛ یک بار |

`case`: `{ id, round, status, field, fieldName, amountMillion, fee, travel, travelKind, commissionPct, commission, arbiterShare, total, paymentStatus, paidByMe, arbiter, visitText, report, photos, reportedAt, appealUntil, rejectUsed, accepted }`
`status`: `awaiting_payment` → `matching` → `offered` → `assigned` → `reported` → (`appealed`) → `final` · یا `refunded`/`cancelled`.
`report`: `{ measure, compare: مطابق|مغایرت جزئی|مغایرت اساسی, verdict: حق با کارفرما|حق با مجری|تقسیم مسئولیت, remedy, upholds? }`

## حل‌کنندهٔ حضوری (مهندس/متخصص) 🔒

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/arbitration/me` | — | `{ arbiter, allowedFields, checklist, stats: { done, active, earned, pending } }` — چک‌لیست شرایط فقط راهنماست؛ تصمیم با ادمین |
| POST | `/arbitration/apply` | multipart: `file` (پروانه/گواهی)، `fields` (`struct,qty` یا JSON)، `range`، `pledge=true` | با نقش فعال مهندس یا متخصص؛ فقط حوزه‌های همان نقش (`BAD_FIELDS`) |
| GET | `/arbitration/jobs` | — | پرونده‌های پیشنهادشده/پذیرفته با `arbiterShare`، شرح اختلاف، محل |
| POST | `/arbitration/jobs/:id/accept` | `{ visitAt, impartial: true }` | زمان بازدید به طرفین اعلام می‌شود |
| POST | `/arbitration/jobs/:id/decline` | — | به حل‌کنندهٔ دیگری سپرده می‌شود |
| POST | `/arbitration/jobs/:id/report` | multipart: ۳ تا ۸ عکس در `photos` + `measure`, `compare`, `verdict`, `remedy` (+ `upholds` در بازبینی) | رأی بازبینی نهایی است |

حوزه‌ها: مهندس `struct` `elec` `mech` `qty` · متخصص `mas` `fin` `iso`.

## ادمین 🛡 (`/admin/arbitration`)

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| GET | `/admin/arbitration/stats` | — | `{ arbitersPending, casesAwaitingPayment, casesWithoutArbiter }` |
| GET | `/admin/arbitration/arbiters?status=pending` | — | درخواست‌ها + `docUrl` |
| POST | `/admin/arbitration/arbiters/:id/approve\|reject\|suspend` | `{ reason? }` | با تأیید، پرونده‌های منتظر دوباره تطبیق داده می‌شوند |
| GET | `/admin/arbitration/cases?status=` | — | |
| POST | `/admin/arbitration/cases/:id/confirm-payment` | `{ ref }` | پرداخت امانی تأیید ← پیشنهاد خودکار به حل‌کننده |
| POST | `/admin/arbitration/cases/:id/assign` | `{ arbiterId }` | تعیین دستی (وقتی حل‌کنندهٔ خودکار پیدا نشد) |
| POST | `/admin/arbitration/cases/:id/refund` | `{ reason }` | حل‌کننده نیامد / پیش از رأی: کل مبلغ برمی‌گردد و ثبت‌کننده می‌تواند دوباره درخواست بدهد |

`feeReturnDue=true` در دور بازبینی یعنی رأی عوض شد و هزینهٔ بازبینی باید به معترض برگردد (فعلاً دستی).

---

# فاز ۸: پنل ادمین — نقش‌ها، دسترسی‌ها، مدیران 🛡

پنل (`blookblu-admin`) با همان ورود پیامکی اپ وارد می‌شود (`/auth/otp/send` و `/auth/otp/verify`)، بعد `/admin/panel/me`.
هر مسیر `/admin/*` نقش مدیر را بررسی می‌کند؛ نبودِ دسترسی ← `403 NO_PERMISSION`، مدیر نبودن ← `403 NOT_ADMIN`.

**نقش‌ها** (جدول `admin_roles`، هم‌تراز با `AROLES` پنل): `owner` مدیر ارشد (همه‌چیز، ثابت) · `content` ناظر محتوا · `support` پشتیبان · `finance` مالی · `arbit` مسئول داوری · `kyc` کارشناس احراز.
دسترسی هر نقش برای ۲۴ بخش پنل: `0` ندارد، `1` مشاهده، `2` ویرایش. **محدودهٔ استان** هر مدیر (`provinces`، خالی = همهٔ ایران) داده‌های تصویر لحظه‌ای را فیلتر می‌کند.
کاربر قدیمیِ `is_admin` خودکار «مدیر ارشد» می‌شود. `npm run admin:grant -- 09xx [--role=kyc]`.

| متد | مسیر | دسترسی | توضیح |
|---|---|---|---|
| GET | `/admin/panel/me` | هر مدیر | `{ admin: { id, name, roleKey, roleName, perms, provinces, phone }, modules, roles }` |
| GET | `/admin/panel/snapshot` | به تفکیک بخش | فقط بخش‌های مجاز: `users` (با مدارک و KYC اگر `kyc`)، `ads`، `reports`، `projects`، `disputes` (+ `cases`)، `arbiters`، `guarantees`، `admins`، `audit`، `stats` (سری ۳۰ روزهٔ ثبت‌نام/آگهی/قرارداد، ترکیب نقش و استان، کارهای در انتظار) |
| PATCH | `/admin/panel/roles/:key` | admins:2 | `{ perms?: { ads: 2, ... }, name?, color? }` — مدیر ارشد ثابت است (`ROLE_FIXED`) |
| POST | `/admin/panel/admins` | admins:2 | `{ phone, name, roleKey, provinces }` — کاربر اگر نبود ساخته می‌شود؛ مدیر ارشد تازه فقط با مدیر ارشد |
| PATCH | `/admin/panel/admins/:id` | admins:2 | `{ name?, roleKey?, provinces?, status: active\|disabled }` — خودت (`SELF`) و آخرین مدیر ارشد (`LAST_OWNER`) نه |
| PATCH | `/admin/panel/ads/:id/status` | ads:2 | `{ status: active\|paused\|closed\|removed, reason? }` — به صاحب آگهی اعلان می‌رود |
| PATCH / DELETE | `/admin/panel/guarantees/:id` | guar:2 | `{ status: accepted\|rejected }` |

دسترسی مسیرهای قبلی: KYC و مدارک ← `kyc` · گزارش‌ها ← `reports` · کاربران و تعلیق ← `users` · حذف آگهی ← `ads` · ردپا ← `audit` · حل‌کننده‌ها ← `arbiters` · پرونده‌ها و تعیین حل‌کننده ← `disputes` · تأیید پرداخت و برگشت پول ← `pay`.

---

# فاز ۸ ب: پنل ادمین کامل، محتوای اپ، تیم و حضور، بازدید مهندس

## تنظیمات قابل تغییر از پنل (`app_config`)
هر کلید یک JSON است؛ سرور در حافظه نگه می‌دارد و پیش‌فرض‌ها در `src/lib/appConfig.ts` است.

| کلید | بخش پنل (دسترسی ویرایش) | اثر در سرور |
|---|---|---|
| `settings` | settings | `flags.maintenance` ← همهٔ مسیرهای اپ `503 MAINTENANCE` (جز auth/app/meta/admin/events) · `flags.arbitration=false` ← `FEATURE_OFF` · `flags.foreign=false` ← `FOREIGN_DISABLED` · `flags.autoFlag=false` ← پیام‌ها علامت نمی‌خورند. روشن کردن حالت تعمیر فقط با مدیر ارشد |
| `coefs` | coefs | `arb`: پایه، کمیسیون ساده/پیچیده، مرز پیچیدگی، رفت‌وآمد، ضرایب مبلغ و حوزه، مهلت گفت‌وگو و اعتراض، شرط سابقه و امتیاز حل‌کننده ← فرمول هزینهٔ داوری · `est`، `tools` برای اپ |
| `legal` | legal | متن قوانین استفاده، حریم خصوصی، قوانین جامعه (نسخه و تاریخ) |
| `stories` | stories | استوری‌های بالای خانهٔ اپ |
| `courses` | academy | دوره‌های آکادمی (`roles` خالی = همه، `st: published\|draft`) |
| `catalog` | catalog | `roles.<نقش>.on=false` ← ثبت‌نام آن نقش `ROLE_DISABLED` · `custom` تصمیم «+ مورد دیگر» · `panel` فهرست‌های نمایشی پنل |
| `visitTypes` | coefs | انواع بازدید مهندس و قیمت |
| `notifTemplates`، `boost` | notif، pay | فقط ذخیره (اعلان خودکار قابل تنظیم و ارتقای پولی آگهی هنوز در سرور نیست) |

## اپ: `/api/app`
| متد | مسیر | توضیح |
|---|---|---|
| GET | `/app/config` | `{ flags, ver, display, legal, stories (فقط روشن‌ها), coefs, visitTypes, roles }` — مهمان هم |
| POST | `/app/stories/:id/view` | شمارش بازدید استوری |
| GET | `/app/courses` | دوره‌های منتشرشده + `done` کاربر (اگر وارد شده) + `badges` |
| PUT | `/app/courses/:id/progress` | `{ done }` — عقب نمی‌رود؛ با تمام شدن درس‌ها `completed` |
| POST | `/app/support` | 🔒 نقش — گفت‌وگوی «پشتیبانی بلوک» (یکی برای هر کاربر). پیام‌ها با همان `/conversations/:id/messages`؛ پیام کاربر تیکت را `open` می‌کند |

پیام مدیر در گفت‌وگوها: `kind: text`، `mine: false`، `admin: "نام مدیر"`. پیام پنهان‌شده توسط مدیر برای کاربران `kind: del`. گفت‌وگوی قفل‌شده: `403 CONV_LOCKED` (در `GET .../messages` هم `conversation.locked`).

## پنل ادمین — بخش ب (`/api/admin/panel`)
تصویر لحظه‌ای (`/snapshot`) این بخش‌ها را هم دارد (هر کدام با دسترسی مشاهده): `conversations` (chats)، `tickets` (support، با پیام‌ها و کد `T-xxxx`)، `broadcasts` (notif، با `opened`)، `config` (همه؛ `values` و `stored`)، `content` (بازدید استوری/دوره و تعداد تمام‌شده)، `custom` (catalog، «+ مورد دیگر» با تعداد)، `qa`، `tx` (pay: پرداخت‌های ثبت‌شده، هزینه و کمیسیون داوری، برگشت، آزادسازی، تسویه)، `status`، `sessions` (admins). حل‌کننده‌ها `earned` (آزادشده)، `paidOut` و `pending` دارند.

| متد | مسیر | دسترسی | توضیح |
|---|---|---|---|
| GET | `/conversations/:id` | chats | همهٔ پیام‌ها (پنهان‌شده و علامت‌خورده هم) با لینک امضاشدهٔ فایل |
| POST | `/conversations/:id/messages` | chats:2 | `{ text }` پیام «پشتیبانی بلوک» که هر دو طرف می‌بینند |
| PATCH | `/conversations/:id` | chats:2 | `{ locked }` + پیام سیستمی |
| PATCH | `/messages/:id` | chats:2 | `{ hidden?, flagged? }` |
| POST | `/users/:id/warn` | chats:2 | `{ text, report? }` اعلان اخطار (+ ثبت در گزارش‌ها) |
| PATCH | `/tickets/:id` | support:2 | `{ status?, priority?, category?, assigneeAdminId? }` — بستن، پیام سیستمی می‌فرستد |
| POST | `/tickets/:id/reply` | support:2 | `{ text }` ← تیکت `pending`، مسئول پیش‌فرض خود مدیر، اعلان به کاربر |
| POST | `/broadcasts/preview` | notif | `{ roles[], provinces[], userIds[] }` ← `{ count }` (با محدودهٔ استان مدیر) |
| POST | `/broadcasts` | notif:2 | همان + `{ title, body?, screen?, targetText? }` ← اعلان داخل اپ و SSE برای همه |
| PUT | `/config/:key` | بسته به کلید (جدول بالا) | `{ value, note? }` — نامعتبر: `BAD_CONFIG` |
| POST | `/catalog/custom` | catalog:2 | `{ role, field, value, action: ok\|rej\|merge, to? }` — ok به گزینه‌های فرم اپ اضافه می‌شود؛ merge مقدار را در پروفایل‌ها جایگزین می‌کند |
| POST | `/payouts` | pay:2 | `{ arbiterId, amount, ref }` تسویهٔ دستی (بیش از مانده: `OVER_BALANCE`) |
| GET | `/status` | status | متریک‌های سرور، دیتابیس، پیامک، ذخیرهٔ فایل |
| DELETE | `/sessions/:id` | admins:2 | بستن نشست مدیر |
| POST | `/roles` | admins:2 | `{ name, color? }` نقش تازه (فقط داشبورد) |

## تیم و حضور و غیاب: `/api/me/team` 🔒 نقش فعال
| متد | مسیر | توضیح |
|---|---|---|
| GET | `/me/team?from=YYYY-MM-DD&days=7` | نیروها با `days: { 'YYYY-MM-DD': 'p'\|'a'\|'l' }`، `present`، `pay` و `totals` (پیش‌فرض ۷ روز تا امروز، وقت تهران) |
| POST | `/me/team` | `{ name, skill, dailyWage, profileCode? }` |
| PATCH / DELETE | `/me/team/:id` | ویرایش (`active` هم) / حذف |
| PUT | `/me/team/:id/attendance` | `{ day?, status: p\|a\|l\|null }` — روز آینده: `FUTURE_DAY` |
| POST | `/me/team/attendance/all-present` | همه امروز حاضر |

## رزرو بازدید مهندس: `/api/visits`
| متد | مسیر | توضیح |
|---|---|---|
| GET | `/visits/slots/:code?days=7` | روزهای پیش رو از فردا: `{ day, label, weekday, open (هفتهٔ مهندس), taken[] }`، `slots` (۸:۰۰، ۱۰:۰۰، ۱۲:۰۰، ۱۶:۰۰)، `types` |
| GET | `/visits` | 🔒 بازدیدهای من (هر دو طرف) با `as: client\|engineer` |
| POST | `/visits` | 🔒 نقش — `{ engineerCode, type (شمارهٔ نوع), day, slot, address, note? }` ← `requested` · خطاها: `DAY_CLOSED`، `SLOT_TAKEN`، `BAD_DAY` (فقط تا ۱۴ روز) |
| POST | `/visits/:id/confirm` · `/decline` | 🔒 مهندس (`{ reason? }`) |
| POST | `/visits/:id/cancel` | 🔒 درخواست‌دهنده؛ بازدید تأییدشده کمتر از ۱۲ ساعت مانده: `LATE_CANCEL` |
| POST | `/visits/:id/done` | 🔒 مهندس، از روز بازدید به بعد: `{ checklist: [{item, ok}], report }` |

---

# تکمیلی: نشست پایدار، بازدید و آمار، پاسخ عمومی پرسش‌ها، پیام صوتی

- **تمدید نشست:** اگر جواب `/auth/refresh` در شبکه گم شود و همان توکن قبلی تا ۳ دقیقه دوباره بیاید، نشست تازه داده می‌شود (ستون `refresh_tokens.replaced_at`). استفادهٔ دوباره بعد از آن، یا توکنِ خروج/تعلیق/سرقت = `REFRESH_REUSED`/`REFRESH_INVALID`.
- **بازدید:** `GET /profiles/:code` و `GET /ads/:id` توسط دیگران (نه خود صاحب) یک بازدید ثبت می‌کند (`profiles.views`، `ads.views` و جدول روزانهٔ `view_days`).
- `GET /me/stats` 🔒 نقش — آمار واقعی ۶ ماه شمسی اخیر: `months`، `profileViews {total, monthly}`، `adViews {total, monthly, activeAds}`، `responses {received, receivedMonthly, sent, sentMonthly, answerRate, avgAnswerMinutes, conversion}`، `projects {total, active, done}`، `income {total, monthly}` (پرداخت‌های تأییدشده که مجری بوده)، `demand [{skill, n}]` (پرتقاضاترین مهارت‌های آگهی‌های ۳۰ روز اخیر در استان).
- `GET /ads/:id/answers` — پاسخ‌های «پرسش تخصصی» برای همه (`[{id, message, createdAt, best, author}]`)؛ نوع دیگر: `NOT_CONSULT`. پاسخ دادن همان `POST /ads/:id/responses`.
- **پیام صوتی:** `POST /conversations/:id/attachments` با فایل صدا (WebM/Ogg/M4A، تشخیص از محتوا) و `duration` ← پیام `kind: voice` با `payload.dur` و لینک امضاشده.

## درخواست همکاری مستقیم: `/api/invites` 👤

دعوت یک یا چند نفر به کار خودت (از پروفایل، یا «نیروی این پروژه» در برآورد). هر درخواست گفت‌وگو با گیرنده باز می‌کند و پیام درخواست اولین پیام آن است.

| متد | مسیر | بدنه | توضیح |
|---|---|---|---|
| POST | `/invites` | `{ profileCode \| profileCodes[≤۳۰], adId?, title, startWhen?, offer?, message? }` | `{ items:[{id, conversationId, code}], skipped:[{code, reason}] }`؛ تکراری در انتظار ← `INVITE_DUPLICATE` |
| GET | `/invites?dir=in\|out` | — | دریافتی (با `from`) یا ارسالی (با `to`)؛ `status: pending\|accepted\|rejected` |
| PATCH | `/invites/:id` | `{ status: accepted\|rejected }` | فقط گیرنده؛ پیام سیستمی در چت + اعلان به فرستنده |
| POST | `/invites/:id/withdraw` | — | پس گرفتن (فقط فرستنده، فقط در انتظار) |

