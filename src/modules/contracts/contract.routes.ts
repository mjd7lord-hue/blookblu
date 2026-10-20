import { Router } from 'express';
import { z } from 'zod';
import { ah, parse, uuidParam } from '../../lib/http';
import { notFound } from '../../lib/errors';
import { toLatinDigits } from '../../lib/text';
import { requireAuth } from '../../middlewares/auth';
import { desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import { contracts, contractSignatures, profiles, projects } from '../../db/schema';
import { apiUrl, checkSigned, signedQuery } from '../../lib/signed';
import * as svc from './contract.service';
import { renderContractHtml } from './contract.print';

/** زیر /api/projects/:id/contract */
export const projectContractRouter = Router({ mergeParams: true });
projectContractRouter.use(requireAuth);

projectContractRouter.get(
  '/',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json({ contract: await svc.getContract(req.user!.id, id) });
  }),
);

projectContractRouter.patch(
  '/',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        milestones: z
          .array(z.object({ title: z.string().trim().min(2).max(60), pct: z.number().int().min(1).max(100) }))
          .min(1)
          .max(8)
          .optional(),
        durationDays: z.number().int().min(1).max(2000).optional(),
        retentionPct: z.number().int().min(0).max(20).optional(),
        retentionMonths: z.number().int().min(1).max(24).optional(),
        delayPenaltyPct: z.number().min(0).max(2).optional(),
        extraClauses: z.array(z.string().trim().min(5).max(600)).max(5).optional(),
      }),
      req.body,
    );
    res.json({ contract: await svc.updateContract(req.user!.id, id, body) });
  }),
);

/** پیامک کد امضا به موبایل خودم */
projectContractRouter.post(
  '/sign-code',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json(await svc.requestSignCode(req.user!.id, id, req.ip));
  }),
);

projectContractRouter.post(
  '/sign',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        code: z.string().transform((v) => toLatinDigits(v).trim()).pipe(z.string().regex(/^\d{5}$/, 'کد ۵ رقمی است')),
        contentHash: z.string().regex(/^[0-9a-f]{64}$/),
      }),
      req.body,
    );
    res.json({ contract: await svc.signContract(req.user!.id, id, body, { ip: req.ip, userAgent: req.headers['user-agent'] }) });
  }),
);

/** /api/contracts/:id/print?exp=&sig= — لینک امضاشده از پاسخ قرارداد (printUrl) */
export const contractPrintRouter = Router();

contractPrintRouter.get(
  '/:id/print',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    if (!checkSigned('contract', id, req.query.exp, req.query.sig)) throw notFound('قرارداد پیدا نشد');
    const found = await svc.contractForPrint(id);
    if (!found) throw notFound('قرارداد پیدا نشد');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src-attr 'unsafe-inline'; img-src data:");
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('html').send(renderContractHtml(found.c, found.sigs, found.pays));
  }),
);

/** /api/me/contracts — بایگانی همهٔ قراردادهای من (همهٔ نقش‌ها)، تازه‌ترین اول — دور ۳۶ */
export const myContractsRouter = Router();
myContractsRouter.use(requireAuth);

myContractsRouter.get(
  '/',
  ah(async (req, res) => {
    const mine = (await db.select({ id: profiles.id, role: profiles.role }).from(profiles).where(eq(profiles.userId, req.user!.id))).map((p) => p.id);
    if (!mine.length) return res.json({ items: [] });
    const rows = await db
      .select({ c: contracts, p: projects })
      .from(contracts)
      .innerJoin(projects, eq(projects.id, contracts.projectId))
      .where(or(inArray(projects.clientProfileId, mine), inArray(projects.providerProfileId, mine)))
      .orderBy(desc(contracts.updatedAt))
      .limit(300);
    const sigs = rows.length
      ? await db
          .select({ contractId: contractSignatures.contractId, version: contractSignatures.version, side: contractSignatures.side, signedAt: contractSignatures.signedAt })
          .from(contractSignatures)
          .where(inArray(contractSignatures.contractId, rows.map((x) => x.c.id)))
      : [];
    res.json({
      items: rows.map(({ c, p }) => {
        const iAmClient = mine.includes(p.clientProfileId);
        const sv = sigs.filter((s) => s.contractId === c.id && s.version === c.version);
        const other = iAmClient ? c.terms.provider : c.terms.client;
        return {
          id: c.id,
          number: c.number,
          version: c.version,
          status: c.status,
          title: c.terms.title,
          dateFa: c.terms.dateFa,
          amount: c.terms.amount,
          priceText: c.terms.priceText,
          myRole: iAmClient ? 'client' : 'provider',
          myProfileRole: iAmClient ? c.terms.client.role : c.terms.provider.role,
          other: { name: other.name, code: other.code },
          signed: { client: sv.some((s) => s.side === 'client'), provider: sv.some((s) => s.side === 'provider') },
          activatedAt: c.activatedAt,
          project: { id: p.id, status: p.status, stage: p.stage },
          printUrl: apiUrl(`/api/contracts/${c.id}/print?${signedQuery('contract', c.id)}`),
          updatedAt: c.updatedAt,
        };
      }),
    });
  }),
);
