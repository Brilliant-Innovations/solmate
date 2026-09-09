'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  address,
  appendTransactionMessageInstructions,
  createClient,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import { walletSigner } from '@solana/kit-plugin-wallet';
import { useConnect, useConnectedWallet, useDisconnect, useIsWalletReady, useWallets, useWalletStatus } from '@solana/kit-plugin-wallet/react';
import { getTransferSolInstruction } from '@solana-program/system';
import { fetchMaybeToken, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { formatBaseUnits as format, shortAddress as short, toBaseUnits } from './amounts';
import { fundingCeilingVerdict, NATIVE_SOL_MINT, validateFundingInstructions, validateFundingTransfer, type FundingRequestPayload, type FundingTransfer, type PreparedInstruction, type SolanaCluster } from '@sol-agent-trader/contracts';

/**
 * Connected Funding Wallet (blueprint §20.18, §3.7, D56; §32 funding substitution). A Wallet
 * Standard connector on Solana Kit for the operator's own external wallet. It is web/UI
 * infrastructure only: never a trading, approval or auth authority, never an armed signer or
 * custody account, and a disconnected wallet is a normal state. The only action is a reviewed,
 * operator-signed manual transfer into the configured trading wallet: the typed guard checks the
 * destination, mint, cluster and instruction list before the wallet prompt, the wallet presents
 * its own approval, and the browser then reports SUBMITTED / FAILED / ABANDONED. Authoritative
 * balances change only when reconciliation confirms the chain deltas.
 */

export interface FundingWalletProps {
  cluster: SolanaCluster;
  tradingWallet: string;
  settlementMint: string;
  settlementSymbol: string;
  settlementDecimals: number;
  /** Read-only RPC for balances and blockhashes; a public endpoint is fine (no key travels to the browser). */
  rpcUrl: string;
  /** D56: the attested capital ceiling and the recognized custody value the projection carries. */
  ceilingUsd: number | null;
  recognizedUsd: number | null;
  /** Current trading-wallet balances the ledger observed, base units. */
  currentSolLamports: string | null;
  currentSettlementBaseUnits: string | null;
  /** Whether the signed-in operator may file control requests (aal2 operator). */
  canFile: boolean;
  /** Files the FUND_TRADING_WALLET control request; supplied by the host app (the connector cannot reach the database). */
  onReport: (payload: FundingRequestPayload) => Promise<{ ok: true } | { ok: false; error: string }>;
}

const CHAIN_BY_CLUSTER: Record<SolanaCluster, `solana:${string}`> = { 'mainnet-beta': 'solana:mainnet', devnet: 'solana:devnet', testnet: 'solana:testnet', localnet: 'solana:localnet' };
const EXPLORER_CLUSTER: Record<SolanaCluster, string> = { 'mainnet-beta': '', devnet: '?cluster=devnet', testnet: '?cluster=testnet', localnet: '?cluster=custom' };
const BASE_FEE_LAMPORTS = 5_000n;
const ATA_RENT_LAMPORTS = 2_039_280n;

type Stage = { step: 'idle' } | { step: 'preparing' } | { step: 'wallet' } | { step: 'submitted'; signature: string } | { step: 'failed'; reason: string } | { step: 'abandoned' };

export function FundingWallet(p: FundingWalletProps) {
  const chain = CHAIN_BY_CLUSTER[p.cluster];
  const client = useMemo(() => createClient().use(walletSigner({ chain, autoConnect: true, storageKey: 'solmate.funding-wallet' })), [chain]);
  const rpc = useMemo(() => createSolanaRpc(p.rpcUrl), [p.rpcUrl]);
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const status = useWalletStatus(client);
  const ready = useIsWalletReady(client);
  const connect = useConnect(client);
  const disconnect = useDisconnect(client);
  const [balanceState, setBalanceState] = useState<{ owner: string; sol: bigint | null; settlement: bigint | null; at: number } | null>(null);
  const [asset, setAsset] = useState<'SOL' | 'SETTLEMENT'>('SETTLEMENT');
  const [amountText, setAmountText] = useState('');
  const [stage, setStage] = useState<Stage>({ step: 'idle' });
  const [destinationAta, setDestinationAta] = useState<string | null>(null);
  const [destinationAtaExists, setDestinationAtaExists] = useState<boolean | null>(null);

  const account = connected?.account ?? null;
  const onChain = account ? account.chains.includes(chain) : false;
  const balances = account && balanceState && balanceState.owner === account.address ? balanceState : null;

  // Source balances (SOL + settlement) for the connected account.
  useEffect(() => {
    let cancelled = false;
    if (!account) return;
    const forOwner = account.address;
    (async () => {
      try {
        const owner = address(forOwner);
        const sol = await rpc.getBalance(owner).send();
        const [ata] = await findAssociatedTokenPda({ owner, mint: address(p.settlementMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
        const token = await fetchMaybeToken(rpc, ata);
        if (!cancelled) setBalanceState({ owner: forOwner, sol: BigInt(sol.value), settlement: token.exists ? BigInt(token.data.amount) : 0n, at: Date.now() });
      } catch {
        if (!cancelled) setBalanceState({ owner: forOwner, sol: null, settlement: null, at: Date.now() });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, rpc, p.settlementMint]);

  // Destination canonical ATA for the settlement mint, and whether it exists yet (rent is part of the fee estimate).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ata] = await findAssociatedTokenPda({ owner: address(p.tradingWallet), mint: address(p.settlementMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
        const token = await fetchMaybeToken(rpc, ata);
        if (!cancelled) {
          setDestinationAta(ata);
          setDestinationAtaExists(token.exists);
        }
      } catch {
        if (!cancelled) setDestinationAtaExists(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, p.tradingWallet, p.settlementMint]);

  const decimals = asset === 'SOL' ? 9 : p.settlementDecimals;
  const amount = toBaseUnits(amountText, decimals);
  const fundingMint = asset === 'SOL' ? NATIVE_SOL_MINT : p.settlementMint;
  const feeLamports = BASE_FEE_LAMPORTS + (asset === 'SETTLEMENT' && destinationAtaExists === false ? ATA_RENT_LAMPORTS : 0n);
  const current = asset === 'SOL' ? (p.currentSolLamports === null ? null : BigInt(p.currentSolLamports)) : (p.currentSettlementBaseUnits === null ? null : BigInt(p.currentSettlementBaseUnits));
  const projected = current !== null && amount !== null ? current + amount : null;
  const addUsd = asset === 'SETTLEMENT' && amount !== null ? Number(amount) / 10 ** p.settlementDecimals : 0;
  const ceiling = fundingCeilingVerdict({ recognizedUsd: p.recognizedUsd, addUsd, ceilingUsd: p.ceilingUsd });
  const transfer: FundingTransfer | null = account && amount !== null ? { sourceWallet: account.address as FundingTransfer['sourceWallet'], destinationTradingWallet: p.tradingWallet as FundingTransfer['destinationTradingWallet'], destinationAta: (asset === 'SOL' ? null : destinationAta) as FundingTransfer['destinationAta'], fundingMint: fundingMint as FundingTransfer['fundingMint'], requestedAmount: String(amount) as FundingTransfer['requestedAmount'], cluster: p.cluster } : null;
  const guard = transfer ? validateFundingTransfer(transfer, { tradingWallet: p.tradingWallet, settlementMint: p.settlementMint, cluster: p.cluster, settlementAta: destinationAta }) : null;
  const canReview = p.canFile && onChain && transfer !== null && guard?.ok === true && stage.step !== 'preparing' && stage.step !== 'wallet' && (asset === 'SOL' || destinationAta !== null);

  async function reviewInWallet() {
    if (!account || !transfer || !guard?.ok) return;
    setStage({ step: 'preparing' });
    try {
      const signer = client.payer as TransactionSigner;
      const source = address(account.address);
      const destination = address(p.tradingWallet);
      const instructions: Instruction[] = [];
      if (asset === 'SOL') {
        instructions.push(getTransferSolInstruction({ source: signer, destination, amount: lamports(amount!) }));
      } else {
        const mint = address(p.settlementMint);
        const [sourceAta] = await findAssociatedTokenPda({ owner: source, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        const destAta = address(transfer.destinationAta as string);
        if (destinationAtaExists === false) instructions.push(await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: destination, mint }));
        instructions.push(getTransferCheckedInstruction({ source: sourceAta, mint, destination: destAta, authority: signer, amount: amount!, decimals: p.settlementDecimals }));
      }
      // The typed guard on the exact instruction list the wallet will be asked to sign (§32).
      const prepared: PreparedInstruction[] = instructions.map((ix) => ({ programAddress: ix.programAddress as string, accountAddresses: (ix.accounts ?? []).map((a) => a.address as string) }));
      const verdict = validateFundingInstructions(prepared, transfer);
      if (!verdict.ok) {
        setStage({ step: 'failed', reason: `refused before the wallet prompt: ${verdict.reasons.join(', ')}` });
        return;
      }
      const { value: blockhash } = await rpc.getLatestBlockhash().send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      );
      setStage({ step: 'wallet' });
      const signatureBytes = await signAndSendTransactionMessageWithSigners(message);
      const signature = getBase58Decoder().decode(signatureBytes);
      const report = await p.onReport({ transfer, outcome: 'SUBMITTED', txSignature: signature, failureReason: null, source: 'wallet-connector' });
      if (!report.ok) {
        setStage({ step: 'failed', reason: `sent (${short(signature)}) but the request could not be filed: ${report.error}; reconciliation still sees the chain` });
        return;
      }
      setStage({ step: 'submitted', signature });
      setAmountText('');
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const abandoned = /reject|denied|cancel|abort/i.test(text);
      await p.onReport({ transfer, outcome: abandoned ? 'ABANDONED' : 'FAILED', txSignature: null, failureReason: text.slice(0, 256), source: 'wallet-connector' }).catch(() => ({ ok: false as const, error: 'unreported' }));
      setStage(abandoned ? { step: 'abandoned' } : { step: 'failed', reason: text });
    }
  }

  const explorer = (a: string) => `https://explorer.solana.com/address/${a}${EXPLORER_CLUSTER[p.cluster]}`;

  return (
    <div>
      <p className="mono" style={{ margin: '0 0 0.4rem' }}>
        <span className="chip" data-tone="observe"><span className="v">EXTERNAL OPERATOR WALLET — NOT USED FOR AUTONOMOUS TRADING</span></span>{' '}
        <span className="chip" data-tone="unknown"><span className="k">network</span><span className="v">{p.cluster}</span></span>{' '}
        <span className="chip" data-tone={status === 'connected' ? 'ok' : 'unknown'}><span className="k">wallet</span><span className="v">{status.toUpperCase()}</span></span>
      </p>
      {!account ? (
        <div className="controls" style={{ gap: '0.4rem' }}>
          {!ready ? <span className="muted mono">discovering wallets…</span> : wallets.length === 0 ? <span className="muted">No Wallet Standard wallet detected in this browser. Disconnected is a normal state; nothing in the trading runtime depends on it.</span> : null}
          {wallets.map((w) => (
            <button key={w.name} type="button" className="btn" onClick={() => connect.dispatch(w)} disabled={connect.status === 'running'} title={`Connect ${w.name}`}>
              {w.icon ? <img src={w.icon} alt="" width={14} height={14} style={{ verticalAlign: 'middle', marginRight: '0.3rem' }} /> : null}
              Connect {w.name}
            </button>
          ))}
          {connect.error ? <span className="mono" style={{ color: 'var(--failed)' }}>{connect.error instanceof Error ? connect.error.message : String(connect.error)}</span> : null}
        </div>
      ) : (
        <>
          <p className="mono" style={{ margin: '0 0 0.3rem' }}>
            {connected!.wallet.icon ? <img src={connected!.wallet.icon} alt="" width={14} height={14} style={{ verticalAlign: 'middle', marginRight: '0.3rem' }} /> : null}
            {connected!.wallet.name} · <a href={explorer(account.address)} target="_blank" rel="noreferrer">{account.address}</a>{' '}
            <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(account.address)} title="Copy address">Copy</button>{' '}
            <button type="button" className="btn" onClick={() => disconnect.dispatch()} disabled={disconnect.status === 'running'}>Disconnect</button>
          </p>
          {!onChain && <p className="mono" style={{ color: 'var(--failed)', margin: '0 0 0.3rem' }}>This wallet account cannot operate on {p.cluster} ({chain}); funding is refused until it can.</p>}
          <p className="mono muted" style={{ margin: '0 0 0.5rem' }}>
            balances: {balances ? `${format(balances.sol, 9)} SOL · ${format(balances.settlement, p.settlementDecimals, 2)} ${p.settlementSymbol}` : 'reading…'}
          </p>

          <div className="card">
            <h3 style={{ margin: '0 0 0.4rem' }}>Fund Trading Wallet (manual, operator-signed)</h3>
            <div className="controls" style={{ gap: '0.5rem' }}>
              <select value={asset} onChange={(e) => setAsset(e.target.value as 'SOL' | 'SETTLEMENT')} aria-label="funding asset" disabled={stage.step === 'preparing' || stage.step === 'wallet'}>
                <option value="SETTLEMENT">{p.settlementSymbol} (settlement)</option>
                <option value="SOL">SOL (gas)</option>
              </select>
              <input className="mono" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder={`amount in ${asset === 'SOL' ? 'SOL' : p.settlementSymbol}`} aria-label="amount" inputMode="decimal" disabled={stage.step === 'preparing' || stage.step === 'wallet'} />
            </div>
            <table className="mono" style={{ borderCollapse: 'collapse', marginTop: '0.5rem' }}>
              <tbody>
                <tr><td className="muted" style={{ padding: '0.15rem 0.8rem 0.15rem 0' }}>source</td><td>{short(account.address)} (connected wallet)</td></tr>
                <tr><td className="muted" style={{ padding: '0.15rem 0.8rem 0.15rem 0' }}>destination</td><td style={{ wordBreak: 'break-all' }}>{p.tradingWallet}{asset === 'SETTLEMENT' ? <div className="muted">canonical ATA {destinationAta ?? 'deriving…'}{destinationAtaExists === false ? ' (will be created)' : ''}</div> : null}</td></tr>
                <tr><td className="muted" style={{ padding: '0.15rem 0.8rem 0.15rem 0' }}>asset · amount</td><td>{asset === 'SOL' ? 'SOL' : `${p.settlementSymbol} ${short(p.settlementMint)}`} · {amount === null ? '—' : format(amount, decimals)}</td></tr>
                <tr><td className="muted" style={{ padding: '0.15rem 0.8rem 0.15rem 0' }}>trading wallet now → after</td><td>{format(current, decimals)} → {format(projected, decimals)}</td></tr>
                <tr><td className="muted" style={{ padding: '0.15rem 0.8rem 0.15rem 0' }}>network · est. fee</td><td>{p.cluster} · ≈ {format(feeLamports, 9, 6)} SOL{asset === 'SETTLEMENT' && destinationAtaExists === false ? ' (includes ATA rent)' : ''}</td></tr>
                <tr><td className="muted" style={{ padding: '0.15rem 0.8rem 0.15rem 0' }}>capital ceiling (D56)</td><td>{p.ceilingUsd === null ? 'no attested ceiling (nothing armed)' : `$${p.ceilingUsd.toLocaleString()} · recognized ${p.recognizedUsd === null ? 'unknown' : `$${p.recognizedUsd.toLocaleString()}`}${ceiling.projectedUsd !== null ? ` → $${ceiling.projectedUsd.toLocaleString()}` : ''}`}{asset === 'SOL' && p.ceilingUsd !== null ? <span className="muted"> · SOL not priced in this review</span> : null}</td></tr>
              </tbody>
            </table>
            {ceiling.exceeds && <p className="mono" style={{ color: 'var(--failed)', margin: '0.4rem 0' }}>RE-ATTESTATION REQUIRED — NEW ENTRIES WILL PAUSE: this funding would take recognized custody above the attested ceiling.</p>}
            {guard && !guard.ok && <p className="mono" style={{ color: 'var(--failed)', margin: '0.4rem 0' }}>refused: {guard.reasons.join(', ')}</p>}
            {!p.canFile && <p className="muted" style={{ margin: '0.4rem 0' }}>Controls are locked for this session (operator role and aal2 required); the wallet prompt is not offered.</p>}
            <div className="controls" style={{ marginTop: '0.5rem' }}>
              <button type="button" className="btn" onClick={reviewInWallet} disabled={!canReview} title="Builds one transfer, runs the typed guard, then the wallet shows its own approval">
                {stage.step === 'preparing' ? 'Preparing…' : stage.step === 'wallet' ? 'Waiting for wallet approval…' : 'Review in wallet'}
              </button>
              {stage.step === 'submitted' && <span className="chip" data-tone="degraded"><span className="v">SUBMITTED — awaiting chain confirmation</span></span>}
              {stage.step === 'submitted' && <a className="mono" href={`https://explorer.solana.com/tx/${stage.signature}${EXPLORER_CLUSTER[p.cluster]}`} target="_blank" rel="noreferrer">{short(stage.signature)}</a>}
              {stage.step === 'failed' && <span className="mono" style={{ color: 'var(--failed)' }}>FAILED: {stage.reason}</span>}
              {stage.step === 'abandoned' && <span className="mono muted">Cancelled in the wallet; no funding authority remains.</span>}
            </div>
            <p className="muted" style={{ margin: '0.4rem 0 0' }}>Browser-reported success never updates balances: reconciliation marks CONFIRMED from chain deltas. No allowance, scheduled funding or background debit exists.</p>
          </div>
        </>
      )}
      <p className="muted" style={{ margin: '0.5rem 0 0' }}>Funding outside the connector: send to <span className="mono" style={{ wordBreak: 'break-all' }}>{p.tradingWallet}</span> on {p.cluster}; reconciliation records any inflow it can explain.</p>
    </div>
  );
}
