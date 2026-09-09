import { addAmounts, amountToBigInt, bigIntToAmount, compareAmounts, subAmounts, type Amount, type Instant, type Position, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { PortfolioState } from '@sol-agent-trader/risk';
import { cohortForAsset, type ActiveMembership } from '@sol-agent-trader/risk';

/**
 * In-memory paper book for one replayed strategy (blueprint §13, §17; P9 "baseline and AI
 * strategies run against the same timeline"). Each strategy owns an isolated book with the same
 * starting capital, so strategies never compete for the same settlement balance and their
 * results are comparable. Accounting mirrors the ledger: cost basis in, proceeds out, fees off
 * the settlement balance, realized P&L on close, marks from the executable exit quote.
 */

export interface ReplayPosition {
  id: Uuid;
  candidateId: Uuid;
  decisionId: Uuid;
  assetId: Uuid;
  mint: string;
  decimals: number;
  quantity: Amount;
  costBasisBaseUnits: Amount;
  averageEntryPrice: number;
  stop: Position['stop'];
  target: Position['target'];
  currentStop: number;
  highSinceEntry: number;
  openedAt: Instant;
  markValue: Amount;
  proposerConfidence: number | null;
}

export interface ReplayBook {
  strategyVersionId: VersionId;
  settlementBalance: Amount;
  feesLamports: Amount;
  positions: ReplayPosition[];
  realizedPnl: bigint;
  dayStartEquity: Amount;
  rollingHighEquity: Amount;
  consecutiveLosses: number;
  sleeve: { id: Uuid; capitalCap: Amount; riskBudget: Amount; committed: Amount; riskUsed: Amount };
}

export function newBook(strategyVersionId: VersionId, sleeveId: Uuid, startingCapital: Amount, sleeveCap: Amount, sleeveRiskBudget: Amount): ReplayBook {
  return {
    strategyVersionId,
    settlementBalance: startingCapital,
    feesLamports: '0' as Amount,
    positions: [],
    realizedPnl: 0n,
    dayStartEquity: startingCapital,
    rollingHighEquity: startingCapital,
    consecutiveLosses: 0,
    sleeve: { id: sleeveId, capitalCap: sleeveCap, riskBudget: sleeveRiskBudget, committed: '0' as Amount, riskUsed: '0' as Amount },
  };
}

export function equityOf(book: ReplayBook): Amount {
  return book.positions.reduce((acc, p) => addAmounts(acc, p.markValue), book.settlementBalance);
}

export function markValueOf(book: ReplayBook): Amount {
  return book.positions.reduce((acc, p) => addAmounts(acc, p.markValue), '0' as Amount);
}

export function portfolioStateOf(book: ReplayBook, assetId: Uuid, memberships: readonly ActiveMembership[], account: { settlementMint: string; settlementDecimals: number; virtualSolLamports: Amount }): PortfolioState {
  const equity = equityOf(book);
  const open = book.positions.map((p) => ({ assetId: p.assetId, costBasis: p.costBasisBaseUnits }));
  const assetExposure = book.positions.filter((p) => p.assetId === assetId).reduce((acc, p) => addAmounts(acc, p.costBasisBaseUnits), '0' as Amount);
  const gas = compareAmounts(account.virtualSolLamports, book.feesLamports) > 0 ? subAmounts(account.virtualSolLamports, book.feesLamports) : ('0' as Amount);
  const fraction = (from: Amount | null): number => (from && amountToBigInt(from) > 0n ? Math.max(0, Number(amountToBigInt(from) - amountToBigInt(equity)) / Number(amountToBigInt(from))) : 0);
  const remaining = (cap: Amount, used: Amount): Amount => (compareAmounts(cap, used) > 0 ? subAmounts(cap, used) : ('0' as Amount));
  return {
    settlementMint: account.settlementMint as PortfolioState['settlementMint'],
    settlementDecimals: account.settlementDecimals,
    equityBaseUnits: equity,
    exposureBaseUnits: markValueOf(book),
    pendingExposureBaseUnits: '0' as Amount,
    inFlightExposureIncreasing: 0,
    openPositions: book.positions.length,
    assetExposureBaseUnits: assetExposure,
    settlementAvailableBaseUnits: book.settlementBalance,
    gasReserveLamports: gas,
    sleeve: { id: book.sleeve.id, active: true, capRemainingBaseUnits: remaining(book.sleeve.capitalCap, book.sleeve.committed), riskRemainingBaseUnits: remaining(book.sleeve.riskBudget, book.sleeve.riskUsed) },
    cohort: cohortForAsset(assetId, open, memberships, equity),
    cluster: null,
    drawdown: { dailyFraction: fraction(book.dayStartEquity), rollingFraction: fraction(book.rollingHighEquity), consecutiveLosses: book.consecutiveLosses, circuitBreakerTripped: false, breakerTrippedAt: null },
    health: { feedsBlockEntries: false, staleDataClasses: [], reconciliationClean: true, dbAvailable: true, executionAnomalies: 0, providerAuthFailure: false, clockDriftMs: 0, operatorKill: false, sessionAllowsEntries: true },
  };
}

export function openPosition(book: ReplayBook, position: ReplayPosition, feeLamports: Amount): void {
  book.settlementBalance = subAmounts(book.settlementBalance, position.costBasisBaseUnits);
  book.feesLamports = addAmounts(book.feesLamports, feeLamports);
  book.sleeve.committed = addAmounts(book.sleeve.committed, position.costBasisBaseUnits);
  book.positions.push(position);
}

export interface CloseResult {
  realizedPnl: bigint;
  proceeds: Amount;
}

export function closePosition(book: ReplayBook, positionId: Uuid, proceeds: Amount, feeLamports: Amount): CloseResult {
  const i = book.positions.findIndex((p) => p.id === positionId);
  if (i < 0) throw new Error(`replay book has no position ${positionId}`);
  const p = book.positions[i]!;
  const realized = amountToBigInt(proceeds) - amountToBigInt(p.costBasisBaseUnits);
  book.settlementBalance = addAmounts(book.settlementBalance, proceeds);
  book.feesLamports = addAmounts(book.feesLamports, feeLamports);
  book.sleeve.committed = compareAmounts(book.sleeve.committed, p.costBasisBaseUnits) > 0 ? subAmounts(book.sleeve.committed, p.costBasisBaseUnits) : ('0' as Amount);
  book.realizedPnl += realized;
  book.consecutiveLosses = realized < 0n ? book.consecutiveLosses + 1 : 0;
  book.positions.splice(i, 1);
  const equity = equityOf(book);
  if (compareAmounts(equity, book.rollingHighEquity) > 0) book.rollingHighEquity = equity;
  return { realizedPnl: realized, proceeds };
}

export function markPosition(book: ReplayBook, positionId: Uuid, markValue: Amount, price: number): void {
  const p = book.positions.find((x) => x.id === positionId);
  if (!p) return;
  p.markValue = markValue;
  if (price > p.highSinceEntry) p.highSinceEntry = price;
}

export function rollDay(book: ReplayBook): void {
  book.dayStartEquity = equityOf(book);
}

export function realizedOf(book: ReplayBook): Amount {
  return bigIntToAmount(book.realizedPnl < 0n ? 0n : book.realizedPnl);
}
