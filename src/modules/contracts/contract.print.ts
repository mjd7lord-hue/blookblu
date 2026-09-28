import type { contracts, contractSignatures } from '../../db/schema';
import { faDate } from './contract.service';

type Contract = typeof contracts.$inferSelect;
type Signature = typeof contractSignatures.$inferSelect;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const nl = (s: string) => esc(s).replace(/\n/g, '<br>');
const faDigits = (s: string) => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
const maskPhone = (p: string) => faDigits(`${p.slice(0, 4)}***${p.slice(-4)}`);

/** صفحهٔ چاپی قرارداد (از مرورگر: چاپ → ذخیره به PDF) */
export function renderContractHtml(c: Contract, sigs: Signature[]) {
  const t = c.terms;
  const sig = (side: 'client' | 'provider', label: string, name: string) => {
    const s = sigs.find((x) => x.side === side);
    return `<div class="sig ${s ? 'on' : ''}"><small>${label}</small><b>${esc(name)}</b>${
      s
        ? `<span>امضای دیجیتال با کد پیامکی به ${maskPhone(s.phone)}</span><span>${faDate(s.signedAt)} · ${faDigits(
            s.signedAt.toISOString().slice(11, 16),
          )} (UTC)</span>`
        : '<span>امضا نشده</span>'
    }</div>`;
  };
  const status = { draft: 'پیش‌نویس — هنوز امضا نشده', signing: 'منتظر امضای طرف دوم', active: 'امضاشده و فعال', void: 'باطل' }[c.status];

  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>قرارداد ${esc(t.number)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font-family: Vazirmatn, Tahoma, 'Segoe UI', sans-serif; color: #1f2937; background: #f3f4f6; margin: 0; line-height: 1.9; }
  .paper { max-width: 780px; margin: 24px auto; background: #fff; padding: 36px 40px; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f766e; padding-bottom: 12px; margin-bottom: 18px; }
  h1 { font-size: 20px; margin: 0; color: #0f766e; }
  header small { display: block; color: #6b7280; }
  .st { font-size: 12px; padding: 2px 10px; border-radius: 99px; background: ${c.status === 'active' ? '#dcfce7;color:#166534' : '#fef3c7;color:#92400e'}; }
  h2 { font-size: 15px; margin: 18px 0 4px; }
  p { margin: 0; font-size: 14px; }
  .sigs { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 28px; }
  .sig { border: 1px dashed #9ca3af; border-radius: 8px; padding: 12px; min-height: 90px; font-size: 13px; }
  .sig.on { border: 1.5px solid #0f766e; background: #f0fdfa; }
  .sig small { color: #6b7280; display: block; } .sig b { display: block; } .sig span { display: block; color: #374151; }
  footer { margin-top: 24px; font-size: 11px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 10px; word-break: break-all; }
  .bar { text-align: center; margin: 16px; } .bar button { font: inherit; padding: 8px 22px; border-radius: 8px; border: 0; background: #0f766e; color: #fff; cursor: pointer; }
  @media print { body { background: #fff; } .paper { box-shadow: none; margin: 0; padding: 0; } .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">چاپ / ذخیره به PDF</button></div>
<main class="paper">
  <header><div><h1>قرارداد همکاری در بلوک</h1><small>شمارهٔ ${esc(t.number)} · ${esc(t.dateFa)} · نسخهٔ ${faDigits(String(c.version))}</small></div><span class="st">${status}</span></header>
  ${t.clauses.map((cl, i) => `<h2>مادهٔ ${faDigits(String(i + 1))} · ${esc(cl.title)}</h2><p>${nl(cl.text)}</p>`).join('\n  ')}
  <div class="sigs">${sig('client', 'کارفرما', t.client.name)}${sig('provider', 'مجری', t.provider.name)}</div>
  <footer>این قرارداد با کد یک‌بارمصرف پیامکی به موبایل هر طرف امضا شده است. اثر انگشت متن (SHA-256): ${esc(c.contentHash)}<br>
  قرارداد بلوک یک نمونهٔ استاندارد است؛ برای کارهای بزرگ متن را با مشاور حقوقی هم بررسی کنید. بلوک طرف قرارداد و واسطهٔ مالی نیست.</footer>
</main></body></html>`;
}
