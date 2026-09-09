'use client';

import { useRouter } from 'next/navigation';
import { FundingWallet, type FundingWalletProps } from '@sol-agent-trader/wallet-ui';
import type { FundingRequestPayload } from '@sol-agent-trader/contracts';
import { createSupabaseBrowserClient } from '../lib/supabase/browser';

/**
 * Host wrapper for the Wallet Standard funding connector (§20.18): the connector never reaches the
 * database, so this component files the FUND_TRADING_WALLET control request as the signed-in
 * operator under RLS. The worker's funding role validates it again and records the event;
 * reconciliation confirms from chain deltas.
 */
export function FundingConnector(props: Omit<FundingWalletProps, 'onReport'>) {
  const router = useRouter();
  const onReport = async (payload: FundingRequestPayload) => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return { ok: false as const, error: 'Supabase is not configured' };
    const { error } = await supabase.schema('ops').from('control_requests').insert({ kind: 'FUND_TRADING_WALLET', payload: payload as never });
    if (error) return { ok: false as const, error: error.message };
    router.refresh();
    return { ok: true as const };
  };
  return <FundingWallet {...props} onReport={onReport} />;
}
