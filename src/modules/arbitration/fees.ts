import { cfg } from '../../lib/appConfig';

/**
 * هزینهٔ داوری حضوری — باید با فرانت (ARB_F، ARB_BASE، ARB_AMT، arbFee در index.html) یکی بماند.
 * هزینه = پایه × ضریب حوزه × ضریب مبلغ (گرد به ۱۰ هزار تومان) + رفت‌وآمد
 * کمیسیون بلوک: ۱۵٪ پروندهٔ ساده، ۲۰٪ پیچیده (مبلغ بالای ۲۰۰ میلیون، حوزهٔ سازه، یا چند موضوع)؛ بقیه + رفت‌وآمد برای حل‌کننده.
 */
export const ARB_FIELDS = {
  struct: { name: 'اسکلت و سازه', who: 'engineer', factor: 1.4, examples: 'بتن، آرماتور، قالب، جوش اسکلت فلزی' },
  mas: { name: 'سفت‌کاری و بنایی', who: 'specialist', factor: 1, examples: 'دیوارچینی، شاقول، ملات، سقف سفال' },
  fin: { name: 'نازک‌کاری', who: 'specialist', factor: 1, examples: 'کاشی، سرامیک، گچ، نقاشی، کف' },
  iso: { name: 'عایق و نم', who: 'specialist', factor: 1.1, examples: 'ایزوگام، نشت آب، نم دیوار' },
  elec: { name: 'تأسیسات برقی', who: 'engineer', factor: 1.2, examples: 'سیم‌کشی، تابلو، ارت' },
  mech: { name: 'تأسیسات مکانیکی', who: 'engineer', factor: 1.2, examples: 'لوله‌کشی، نشتی، موتورخانه' },
  qty: { name: 'متره و صورت‌وضعیت', who: 'engineer', factor: 1.1, examples: 'مقدار کار انجام‌شده، مبلغ مرحله' },
} as const;
export type ArbField = keyof typeof ARB_FIELDS;
export const ARB_FIELD_KEYS = Object.keys(ARB_FIELDS) as ArbField[];

// ضرایب از تنظیمات پنل (بخش «ضرایب و فرمول‌ها»)؛ پیش‌فرض‌ها در lib/appConfig هم‌تراز با فرانت
export type TravelKind = 'city' | 'prov' | 'far';
const A = () => cfg('coefs').arb;
export const arbBase = () => A().base;
export const arbTravel = (): Record<TravelKind, number> => A().travel;
export const fieldFactor = (f: ArbField) => A().fields[f] ?? ARB_FIELDS[f].factor;
export const arbHours = () => ({ talk: A().talk, appeal: A().appeal });
const faM = (n: number) => (n >= 1000 ? (n / 1000).toLocaleString('fa-IR') + ' میلیارد' : n.toLocaleString('fa-IR') + ' میلیون');
/** [سقف مبلغ به میلیون تومان، ضریب، برچسب] — آخرین پله بی‌سقف */
export function arbAmountTiers(): [number, number, string][] {
  const t = [...A().amt].sort((a, b) => a[0] - b[0]);
  return t.map(([max, k], i) => {
    const last = i === t.length - 1;
    const lo = i ? t[i - 1][0] : 0;
    const label = last ? `بیش از ${faM(lo)}` : lo ? `${faM(lo).replace(' میلیون', '')} تا ${faM(max)}` : `تا ${faM(max)}`;
    return [last ? Infinity : max, k, label];
  });
}

// حوزه‌هایی که هر نقش می‌تواند داوری کند (فقط حوزه‌ای که مدرکش را دارد)
export const fieldsForRole = (role: string) => ARB_FIELD_KEYS.filter((k) => ARB_FIELDS[k].who === role);

export function arbFee(input: { field: ArbField; amountMillion: number; multi: boolean }, travelKind: TravelKind) {
  const F = ARB_FIELDS[input.field];
  const C = A();
  const tiers = arbAmountTiers();
  const tier = tiers.find((t) => input.amountMillion <= t[0]) ?? tiers[tiers.length - 1];
  const fee = Math.round((C.base * fieldFactor(input.field) * tier[1]) / 10_000) * 10_000;
  // پیچیده: مبلغ بالای مرز، حوزهٔ سازه، یا چند موضوع (هم‌تراز با پنل)
  const complex = input.amountMillion > C.cplxAmt || input.field === 'struct' || input.multi;
  const commissionPct = complex ? C.complex : C.simple;
  const commission = Math.round((fee * commissionPct) / 100 / 1000) * 1000;
  const travel = C.travel[travelKind] ?? 0;
  return {
    field: input.field,
    fieldName: F.name,
    who: F.who,
    amountMillion: input.amountMillion,
    amountTier: tier[2],
    fee,
    complex,
    commissionPct,
    commission,
    travelKind,
    travel,
    arbiterShare: fee - commission + travel,
    total: fee + travel,
  };
}
export type FeeQuote = ReturnType<typeof arbFee>;

/** بازبینی: نصف هزینهٔ داوری، بدون رفت‌وآمد؛ همان درصد کمیسیون */
export function appealFee(first: { fee: number; commissionPct: number }) {
  const fee = Math.round(first.fee / 2 / 10_000) * 10_000;
  const commission = Math.round((fee * first.commissionPct) / 100 / 1000) * 1000;
  return { fee, commissionPct: first.commissionPct, commission, travel: 0, travelKind: 'city' as TravelKind, arbiterShare: fee - commission, total: fee };
}
