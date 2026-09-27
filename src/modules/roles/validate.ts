import type { Role } from '../../db/schema';
import { badRequest } from '../../lib/errors';
import { normalizeFa, toLatinDigits } from '../../lib/text';
import { allFields, PROVINCES, type Field } from './forms';

export type RoleData = Record<string, unknown>;

const cleanStr = (v: unknown) => (typeof v === 'string' ? normalizeFa(v).replace(/[<>]/g, '') : '');

function checkField(f: Field, raw: unknown): { value?: unknown; error?: string } {
  switch (f.t) {
    case 'text':
    case 'area': {
      const s = cleanStr(raw);
      const max = f.t === 'area' ? 1000 : 120;
      if (s.length < 2) return { error: `${f.label}: حداقل ۲ حرف` };
      if (s.length > max) return { error: `${f.label}: حداکثر ${max} حرف` };
      if (f.pattern && !f.pattern.test(toLatinDigits(s))) return { error: f.patternMsg ?? `${f.label} معتبر نیست` };
      return { value: f.pattern ? toLatinDigits(s) : s };
    }
    case 'num': {
      const digits = toLatinDigits(String(raw ?? '')).replace(/[^\d]/g, '');
      if (!digits) return { error: `${f.label}: یک عدد وارد کنید` };
      const n = Number(digits);
      if (!Number.isSafeInteger(n) || n < 0) return { error: `${f.label}: عدد معتبر نیست` };
      return { value: n };
    }
    case 'toggle':
      return { value: raw === true || raw === 'true' || raw === 1 };
    case 'chips': {
      const s = cleanStr(raw);
      if (f.opts?.includes(s)) return { value: s };
      if (f.custom && s.length >= 2 && s.length <= 40) return { value: s };
      return { error: `${f.label}: یکی از گزینه‌ها را انتخاب کنید` };
    }
    case 'multi': {
      if (!Array.isArray(raw)) return { error: `${f.label}: فهرست گزینه‌ها لازم است` };
      const vals = [...new Set(raw.map(cleanStr).filter(Boolean))];
      if (f.max && vals.length > f.max) return { error: `${f.label}: حداکثر ${f.max} مورد` };
      for (const v of vals) {
        const ok = f.opts?.includes(v) || (f.custom && v.length >= 2 && v.length <= 40);
        if (!ok) return { error: `${f.label}: «${v}» معتبر نیست` };
      }
      return { value: vals };
    }
    case 'days': {
      if (!Array.isArray(raw)) return { error: `${f.label}: روزها را انتخاب کنید` };
      const vals = [...new Set(raw.map((x) => Number(x)))].filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
      if (vals.length !== raw.length) return { error: `${f.label}: روز نامعتبر (۰=شنبه تا ۶=جمعه)` };
      return { value: vals.sort() };
    }
    case 'prov': {
      const s = cleanStr(raw);
      return PROVINCES.includes(s) ? { value: s } : { error: `${f.label}: استان معتبر نیست` };
    }
    case 'city': {
      const s = cleanStr(raw);
      return s.length >= 2 && s.length <= 60 ? { value: s } : { error: `${f.label}: نام شهر را بنویسید` };
    }
  }
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * دادهٔ فرم نقش را اعتبارسنجی می‌کند.
 * partial=true برای ویرایش: فقط فیلدهای فرستاده‌شده بررسی و با دادهٔ قبلی ادغام می‌شود.
 */
export function validateRoleData(role: Role, input: RoleData, prev: RoleData = {}, partial = false): RoleData {
  const merged: RoleData = partial ? { ...prev, ...input } : { ...input };
  const out: RoleData = {};
  const errors: Record<string, string> = {};

  for (const f of allFields(role)) {
    const visible = !f.show || f.show(merged);
    if (!visible) continue;
    const raw = merged[f.k];
    if (isEmpty(raw)) {
      if (f.req && (!partial || f.k in input || isEmpty(prev[f.k]))) errors[f.k] = `${f.label} لازم است`;
      continue;
    }
    if (f.t === 'toggle' && raw === false) {
      out[f.k] = false;
      continue;
    }
    const r = checkField(f, raw);
    if (r.error) errors[f.k] = r.error;
    else out[f.k] = r.value;
  }

  if (Object.keys(errors).length) {
    throw badRequest('بعضی از فیلدها کامل یا درست نیست', 'ROLE_FORM_INVALID', { fields: errors });
  }
  return out;
}
