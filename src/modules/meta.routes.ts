import { Router } from 'express';
import { formsForClient, PROVINCES, EXP, RANGE_OPTS } from './roles/forms';
import { AUDIENCE } from './ads/ads.service';
import { REPORT_REASONS } from './safety/safety.routes';

/** داده‌های ثابت که اپ لازم دارد (فرم‌ها، استان‌ها، ...) */
const r = Router();

r.get('/roles', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ roles: formsForClient() });
});

r.get('/options', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ provinces: PROVINCES, experience: EXP, ranges: RANGE_OPTS, adAudience: AUDIENCE, reportReasons: REPORT_REASONS });
});

export default r;
