/**
 * POST /api/admin/export-calendar (要ログイン・部門ごと)
 * 指定期間の予約を月カレンダー形式のExcelファイルにして返す。
 */
import { exportCalendar } from '../../lib/calendar-export.js';
import { requireAdmin } from '../../lib/auth.js';
import {
  readJsonBody, withErrorHandling, methodNotAllowed, noStore, resolveDepartment,
} from '../../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const body = await readJsonBody(req);
  const dept = await resolveDepartment(req, res, body);
  if (!dept) return;
  if (!requireAdmin(req, res, dept.slug)) return;

  const result = await exportCalendar({ ...body, dept: dept.slug });
  if (!result.ok) return res.status(200).json(result);

  // ファイル名に日本語が入るので RFC 5987 形式でも渡す
  const encoded = encodeURIComponent(result.fileName);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="calendar.xlsx"; filename*=UTF-8''${encoded}`
  );
  res.setHeader('X-Booking-Count', String(result.count));
  res.setHeader('X-File-Name', encoded);
  res.setHeader('Access-Control-Expose-Headers', 'X-Booking-Count, X-File-Name');
  res.status(200).end(result.buffer);
});
