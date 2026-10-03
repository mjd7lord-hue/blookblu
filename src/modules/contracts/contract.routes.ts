import { Router } from 'express';
import { z } from 'zod';
import { ah, parse, uuidParam } from '../../lib/http';
import { checkSigned } from '../../lib/signed';
import { notFound } from '../../lib/errors';
import { toLatinDigits } from '../../lib/text';
import { requireAuth } from '../../middlewares/auth';
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
