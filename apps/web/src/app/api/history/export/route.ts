import { loadTradeHistory, parseTradeFilters, tradesToCsv } from '../../../../lib/history';
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
  const rows = await loadTradeHistory(parseTradeFilters(params));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if ((params['format'] ?? 'csv') === 'json') {
    return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), filters: params, rows }, null, 2), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="trade-history-${stamp}.json"` } });
  }
  return new Response(tradesToCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="trade-history-${stamp}.csv"` } });
}
