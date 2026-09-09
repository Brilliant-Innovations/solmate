import { csvCell, loadTradeHistory, parseTradeFilters, tradesToCsv } from '../../../../lib/history';
import { getOperatorSession } from '../../../../lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Trade History export (§20.10): the filtered rows as CSV or JSON, read as the signed-in user
 * under RLS, with strategy lot, cost basis, every fee class, slippage, action-cycle ids, versions
 * and realized outcomes. No financial state is changed and no secret is involved.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getOperatorSession();
  if (!session || !session.role) return new Response('sign in as an operator to export', { status: 401 });
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    params[k] = v;
  });
  const filters = parseTradeFilters(params);
  const { rows, problems, scanned, truncated } = await loadTradeHistory(filters);
  const provenance = { exportedAt: new Date().toISOString(), filters: params, effectiveLimit: filters.limit, lotsScanned: scanned, truncated, problems };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if ((params['format'] ?? 'csv') === 'json') {
    return new Response(JSON.stringify({ ...provenance, rows }, null, 2), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="trade-history-${stamp}.json"` } });
  }
  // Provenance trails the rows so the header stays row 1 for a spreadsheet: how many lots were
  // scanned, whether the scan was cut short, and any sub-query that failed. The page carries the
  // loud version; the file carries the record (review 2026-09-09, H-3/H-4).
  const trailer = [`# exported_at,${provenance.exportedAt}`, `# lots_scanned,${scanned}`, `# effective_limit,${filters.limit}`, `# truncated,${truncated}`, ...problems.map((x) => `# problem,${csvCell(x)}`)].join('\n') + '\n';
  return new Response(tradesToCsv(rows) + trailer, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="trade-history-${stamp}.csv"` } });
}
