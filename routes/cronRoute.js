// routes/cronRoute.js
import express from 'express';
import crypto from 'crypto';
import { runProfitUpdate } from '../cronJobs.js';

const router = express.Router();

router.get('/cron/profit-update', async (req, res) => {
  // 🔒 Security: verify secret token
  const expected = process.env.CRON_SECRET;
  const secret = req.headers['x-cron-secret'];
  const a = Buffer.from(String(secret || ''));
  const b = Buffer.from(String(expected || ''));

  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn('[CRON] ❌ Unauthorized attempt from:', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[CRON] 🚀 Triggered by cron-job.org');
    const result = await runProfitUpdate();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[CRON] ❌ Failed:', err);
    res.status(500).json({ error: 'Profit update failed' });
  }
});

export default router;