/**
 * 管理画面の枠管理API(要ログイン・部門ごと)。
 *   GET    /api/admin/slots?dept=xxx&schoolId=yyy   全ての枠
 *   POST   /api/admin/slots                         { dept, schoolId, slots: [...] } 枠を追加
 *   PATCH  /api/admin/slots                         1件更新、または { action:'bulkCapacity' } で一括変更
 *   DELETE /api/admin/slots                         { id } 1件削除 / { ids } 一括削除
 */
import {
  getAllSlots,
  adminAddSlots,
  adminUpdateSlot,
  adminBulkUpdateCapacity,
  adminDeleteSlot,
  adminDeleteSlots,
} from '../../lib/store.js';
import { requireAdmin } from '../../lib/auth.js';
import {
  readJsonBody, withErrorHandling, methodNotAllowed, noStore, resolveDepartment,
} from '../../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);

  if (req.method === 'GET') {
    const dept = await resolveDepartment(req, res);
    if (!dept) return;
    if (!requireAdmin(req, res, dept.slug)) return;
    const schoolId = req.query.schoolId;
    if (!schoolId) return res.status(400).json({ ok: false, error: '校舎が指定されていません' });
    return res.status(200).json({
      ok: true,
      slots: await getAllSlots(String(schoolId), dept.slug),
    });
  }

  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
    const body = await readJsonBody(req);
    const dept = await resolveDepartment(req, res, body);
    if (!dept) return;
    if (!requireAdmin(req, res, dept.slug)) return;
    const payload = { ...body, dept: dept.slug };

    if (req.method === 'POST') {
      return res.status(200).json(await adminAddSlots(payload));
    }
    if (req.method === 'PATCH') {
      if (payload.action === 'bulkCapacity') {
        return res.status(200).json(await adminBulkUpdateCapacity(payload));
      }
      return res.status(200).json(await adminUpdateSlot(payload));
    }
    if (Array.isArray(payload.ids)) {
      return res.status(200).json(await adminDeleteSlots(payload));
    }
    return res.status(200).json(await adminDeleteSlot(payload));
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
});
