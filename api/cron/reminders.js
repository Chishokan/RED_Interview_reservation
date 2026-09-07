/**
 * GET /api/cron/reminders
 * 翌日の面談予約にリマインドメールを送る。Vercel Cron から定期実行される。
 *
 * Vercel Cron は Authorization: Bearer $CRON_SECRET を付けて呼び出す。
 * CRON_SECRET を設定していれば、外部からの無断実行を防げる。
 */
import { sendReminders } from '../../lib/notify.js';
import { withErrorHandling, noStore } from '../../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.authorization || '';
    if (header !== `Bearer ${secret}`) {
      return res.status(401).json({ ok: false, error: '認証が必要です' });
    }
  }
  const result = await sendReminders();
  console.log('[cron] リマインド送信:', JSON.stringify(result));
  res.status(200).json(result);
});
