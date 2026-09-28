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

export const ARB_BASE = 1_200_000;
export const ARB_TRAVEL = { city: 0, prov: 600_000, far: 2_000_000 } as const;
export type TravelKind = keyof typeof ARB_TRAVEL;
// [سقف مبلغ به میلیون تومان، ضریب، برچسب]
export const ARB_AMOUNT_TIERS: [number, number, string][] = [
  [50, 1, 'تا ۵۰ میلیون'],
  [200, 1.6, '۵۰ تا ۲۰۰ میلیون'],
  [1000, 2.6, '۲۰۰ میلیون تا ۱ میلیارد'],
  [Infinity, 4, 'بیش از ۱ میلیارد'],
];

// حوزه‌هایی که هر نقش می‌تواند داوری کند (فقط حوزه‌ای که مدرکش را دارد)
export const fieldsForRole = (role: string) => ARB_FIELD_KEYS.filter((k) => ARB_FIELDS[k].who === role);

export function arbFee(input: { field: ArbField; amountMillion: number; multi: boolean }, travelKind: TravelKind) {
  const F = ARB_FIELDS[input.field];
  const tier = ARB_AMOUNT_TIERS.find((t) => input.amountMillion <= t[0])!;
  const fee = Math.round((ARB_BASE * F.factor * tier[1]) / 10_000) * 10_000;
  const complex = input.amountMillion > 200 || F.factor >= 1.4 || input.multi;
  const commissionPct = complex ? 20 : 15;
  const commission = Math.round((fee * commissionPct) / 100 / 1000) * 1000;
  const travel = ARB_TRAVEL[travelKind];
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
