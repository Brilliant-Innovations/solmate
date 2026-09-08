import { toInstant, SignedApprovalGrant, SignedRiskAuthorizedIntent, type Instant, type Sha256Hex, type TradeIntent, type Uuid } from '@sol-agent-trader/contracts';
import { loadTradeIntent } from './executor-repo.js';
import { asJson, type Sql } from './sql.js';

/**
 * Live intent path persistence (blueprint §15.3–15.6, §20.8; execution plan M7). The authorizer
 * writes authorizations; the executor writes attempts; this repo reads what sits between them
 * (authorized, unexpired intents without an attempt) and records LIVE_APPROVAL grants, which are
 * append-only except for revocation (trading.approvals guard).
 */

export interface AuthorizedIntentRow {
  intent: TradeIntent;
  envelope: SignedRiskAuthorizedIntent;
  authorizationHash: Sha256Hex;
  authorizationExpiresAt: Instant;
}

/** AUTHORIZED intents for the account whose authorization has not expired and which have no order attempt yet. */
export async function listAuthorizedIntentsAwaitingExecution(sql: Sql, accountId: Uuid, now: Instant, limit: number): Promise<AuthorizedIntentRow[]> {
  const rows = await sql<{ intent_id: string; envelope: unknown; authorization_hash: string; expires_at: string }[]>`
    select a.intent_id, a.envelope, a.authorization_hash, a.expires_at
    from trading.risk_authorizations a join trading.intents i on i.id = a.intent_id
    where i.account_id = ${accountId} and i.lifecycle_state in ('AUTHORIZED', 'APPROVED') and a.expires_at > ${now}
      and not exists (select 1 from trading.orders o where o.intent_id = i.id)
    order by a.created_at asc limit ${limit}`;
  const out: AuthorizedIntentRow[] = [];
  for (const r of rows) {
    const parsed = SignedRiskAuthorizedIntent.safeParse(r.envelope);
    const intent = await loadTradeIntent(sql, r.intent_id as Uuid);
    if (!parsed.success || !intent) continue;
    out.push({ intent, envelope: parsed.data, authorizationHash: r.authorization_hash as Sha256Hex, authorizationExpiresAt: toInstant(new Date(r.expires_at)) });
  }
  return out;
}

export async function loadAuthorizationForIntent(sql: Sql, intentId: Uuid): Promise<{ envelope: SignedRiskAuthorizedIntent; authorizationHash: Sha256Hex; expiresAt: Instant } | null> {
  const [r] = await sql<{ envelope: unknown; authorization_hash: string; expires_at: string }[]>`select envelope, authorization_hash, expires_at from trading.risk_authorizations where intent_id = ${intentId} order by created_at desc limit 1`;
  if (!r) return null;
  const parsed = SignedRiskAuthorizedIntent.safeParse(r.envelope);
  return parsed.success ? { envelope: parsed.data, authorizationHash: r.authorization_hash as Sha256Hex, expiresAt: toInstant(new Date(r.expires_at)) } : null;
}

/** Records a signed grant; the row's columns mirror the payload so the executor and the UI can query without parsing. */
export async function insertApproval(sql: Sql, envelope: SignedApprovalGrant): Promise<void> {
  const g = SignedApprovalGrant.parse(envelope).payload;
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`
      insert into trading.approvals (authorization_hash, intent_id, approver_id, role, step_up_assertion_ref, granted_at, expires_at, nonce, envelope)
      values (${g.authorizationHash}, ${g.intentId}, ${g.approverId}, ${g.role}, ${g.stepUpAssertionRef}, ${g.grantedAt}, ${g.expiresAt}, ${g.nonce}, ${t.json(asJson(envelope))})`;
    await t`update trading.intents set lifecycle_state = 'APPROVED' where id = ${g.intentId} and lifecycle_state = 'AUTHORIZED'`;
  });
}

export async function listLiveAccounts(sql: Sql): Promise<{ id: Uuid; name: string; settlementMint: string; tradingWallet: string; cluster: string }[]> {
  const rows = await sql<{ id: string; name: string; settlement_mint: string; trading_wallet: string; cluster: string }[]>`select id, name, settlement_mint, trading_wallet, cluster from trading.accounts where mode = 'LIVE' order by created_at asc`;
  return rows.map((r) => ({ id: r.id as Uuid, name: r.name, settlementMint: r.settlement_mint, tradingWallet: r.trading_wallet, cluster: r.cluster }));
}
