/**
 * The paper perps engine. Pure functions over a plain account object.
 *
 * Realism rules, because "paper trading fills at the last price" is the lie
 * this project exists to fix:
 *  - Market orders WALK THE LIVE ORDER BOOK. Size moves the fill.
 *  - Every fill pays a taker fee.
 *  - Isolated margin, with a liquidation price derived from the coin's
 *    maintenance margin. Hit it and the margin is gone.
 *  - Stops and targets trigger on the mid, then fill against the book like any
 *    other market order, so a stop in a thin book slips.
 */

import type { Book } from './hl';
import type { PaperFillAction } from './xp';

/** Approximate base-tier taker fee. Stated, not hidden. */
export const TAKER_FEE = 0.00045;

export type Side = 'long' | 'short';

export interface Position {
  coin: string;
  side: Side;
  qty: number;
  entry: number;
  leverage: number;
  maxLeverage: number;
  margin: number;
  stop: number | null;
  /** The stop as first set. Never moves: it is the risk truly taken. */
  initialStop: number | null;
  target: number | null;
  stopWidenings: number;
  entryFee: number;
  openedAt: number;
  equityAtEntry: number;
  riskPerTradePct: number;
}

export interface ClosedTrade {
  id: string;
  coin: string;
  side: Side;
  qty: number;
  entry: number;
  exit: number;
  leverage: number;
  initialStop: number | null;
  target: number | null;
  stopWidenings: number;
  exitReason: PaperFillAction;
  realizedPnl: number;
  plannedRisk: number | null;
  rMultiple: number | null;
  equityAtEntry: number;
  riskPerTradePct: number;
  openedAt: number;
  closedAt: number;
}

export interface Account {
  startingCash: number;
  /** Free collateral. Margin in open positions is NOT in here. */
  cash: number;
  positions: Record<string, Position>;
  history: ClosedTrade[];
}

export const newAccount = (startingCash = 10_000): Account => ({
  startingCash, cash: startingCash, positions: {}, history: [],
});

const sign = (s: Side) => (s === 'long' ? 1 : -1);

/** Maintenance margin rate: half the initial margin at max leverage. */
export const mmr = (maxLeverage: number) => 1 / (2 * maxLeverage);

export function liquidationPrice(p: Pick<Position, 'side' | 'qty' | 'entry' | 'margin' | 'maxLeverage'>): number {
  const m = mmr(p.maxLeverage);
  return p.side === 'long'
    ? (p.qty * p.entry - p.margin) / (p.qty * (1 - m))
    : (p.margin + p.qty * p.entry) / (p.qty * (1 + m));
}

export function unrealized(p: Position, mark: number): number {
  return (mark - p.entry) * p.qty * sign(p.side);
}

export function equity(a: Account, marks: Record<string, number>): number {
  let e = a.cash;
  for (const p of Object.values(a.positions)) {
    e += p.margin + unrealized(p, marks[p.coin] ?? p.entry);
  }
  return e;
}

/**
 * Walk the book for `qty`. Buying consumes asks, selling consumes bids. If the
 * visible book is too thin, the remainder fills 0.5% beyond the last level, so
 * size in an empty book costs you instead of filling free.
 */
export function walkBook(book: Book, buy: boolean, qty: number): { avg: number; slippageBps: number } | null {
  const levels = buy ? book.asks : book.bids;
  if (!levels.length) return null;
  const top = levels[0][0];
  let left = qty;
  let cost = 0;
  for (const [px, sz] of levels) {
    const take = Math.min(left, sz);
    cost += take * px;
    left -= take;
    if (left <= 0) break;
  }
  if (left > 0) {
    const last = levels[levels.length - 1][0];
    cost += left * last * (buy ? 1.005 : 0.995);
  }
  const avg = cost / qty;
  return { avg, slippageBps: Math.abs(avg - top) / top * 10_000 };
}

export interface OpenRequest {
  coin: string;
  side: Side;
  notional: number;
  leverage: number;
  maxLeverage: number;
  stop: number | null;
  target: number | null;
  riskPerTradePct: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function openPosition(
  a: Account, req: OpenRequest, book: Book, marks: Record<string, number>, now = Date.now(),
): Result<{ account: Account; slippageBps: number }> {
  if (a.positions[req.coin]) return { ok: false, error: `Already in ${req.coin}. Close it first (one position per coin).` };
  if (!(req.notional > 0)) return { ok: false, error: 'Enter a size.' };
  if (req.leverage < 1 || req.leverage > req.maxLeverage) return { ok: false, error: `Leverage must be 1 to ${req.maxLeverage}×.` };
  const mid = marks[req.coin];
  if (!mid) return { ok: false, error: 'No price yet.' };

  const buy = req.side === 'long';
  const qty = req.notional / mid;
  const fill = walkBook(book, buy, qty);
  if (!fill) return { ok: false, error: 'Order book is empty. Try again in a second.' };

  if (req.stop != null) {
    if (buy && req.stop >= fill.avg) return { ok: false, error: 'A long stop must sit below the entry.' };
    if (!buy && req.stop <= fill.avg) return { ok: false, error: 'A short stop must sit above the entry.' };
  }
  if (req.target != null) {
    if (buy && req.target <= fill.avg) return { ok: false, error: 'A long target must sit above the entry.' };
    if (!buy && req.target >= fill.avg) return { ok: false, error: 'A short target must sit below the entry.' };
  }

  const notional = qty * fill.avg;
  const margin = notional / req.leverage;
  const fee = notional * TAKER_FEE;
  if (margin + fee > a.cash) return { ok: false, error: `Not enough free collateral: need $${(margin + fee).toFixed(2)}.` };

  const pos: Position = {
    coin: req.coin, side: req.side, qty, entry: fill.avg,
    leverage: req.leverage, maxLeverage: req.maxLeverage, margin,
    stop: req.stop, initialStop: req.stop, target: req.target,
    stopWidenings: 0, entryFee: fee, openedAt: now,
    equityAtEntry: equity(a, marks), riskPerTradePct: req.riskPerTradePct,
  };

  if (req.stop != null) {
    const liq = liquidationPrice(pos);
    if (buy ? req.stop <= liq : req.stop >= liq) {
      return { ok: false, error: `Stop is past the liquidation price (${liq.toFixed(4)}). Lower the leverage.` };
    }
  }

  return {
    ok: true,
    value: {
      account: { ...a, cash: a.cash - margin - fee, positions: { ...a.positions, [req.coin]: pos } },
      slippageBps: fill.slippageBps,
    },
  };
}

export function closePosition(
  a: Account, coin: string, book: Book | undefined, mark: number, reason: PaperFillAction, now = Date.now(),
): { account: Account; trade: ClosedTrade } | null {
  const p = a.positions[coin];
  if (!p) return null;

  let exit: number;
  let proceeds: number;
  let pnl: number;
  if (reason === 'liquidation') {
    exit = liquidationPrice(p);
    pnl = -p.margin;
    proceeds = 0;
  } else {
    const fill = book ? walkBook(book, p.side === 'short', p.qty) : null;
    exit = fill?.avg ?? mark;
    const exitFee = p.qty * exit * TAKER_FEE;
    pnl = unrealized(p, exit) - exitFee;
    proceeds = Math.max(0, p.margin + pnl);
  }

  const realizedPnl = pnl - p.entryFee;
  const plannedRisk = p.initialStop != null ? Math.abs(p.entry - p.initialStop) * p.qty : null;
  const rMultiple = plannedRisk && plannedRisk > 0 ? realizedPnl / plannedRisk : null;

  const trade: ClosedTrade = {
    id: `${coin}-${now}`, coin, side: p.side, qty: p.qty, entry: p.entry, exit,
    leverage: p.leverage, initialStop: p.initialStop, target: p.target,
    stopWidenings: p.stopWidenings, exitReason: reason, realizedPnl, plannedRisk, rMultiple,
    equityAtEntry: p.equityAtEntry, riskPerTradePct: p.riskPerTradePct,
    openedAt: p.openedAt, closedAt: now,
  };

  const positions = { ...a.positions };
  delete positions[coin];
  return { account: { ...a, cash: a.cash + proceeds, positions, history: [...a.history, trade] }, trade };
}

/**
 * Move a stop. Moving it AWAY from the market (more risk) is a widening and is
 * counted forever. Moving it toward the market (a trail) is free. Removing a
 * stop entirely counts as a widening, because it is the widest widening there is.
 */
export function moveStop(a: Account, coin: string, stop: number | null): Result<Account> {
  const p = a.positions[coin];
  if (!p) return { ok: false, error: 'No position.' };
  if (stop != null) {
    const liq = liquidationPrice(p);
    if (p.side === 'long' && stop <= liq) return { ok: false, error: 'Stop is past liquidation.' };
    if (p.side === 'short' && stop >= liq) return { ok: false, error: 'Stop is past liquidation.' };
  }
  let widened = false;
  if (p.stop != null) {
    if (stop == null) widened = true;
    else widened = p.side === 'long' ? stop < p.stop : stop > p.stop;
  }
  const initialStop = p.initialStop ?? stop;
  const next = { ...p, stop, initialStop, stopWidenings: p.stopWidenings + (widened ? 1 : 0) };
  return { ok: true, value: { ...a, positions: { ...a.positions, [coin]: next } } };
}

export function moveTarget(a: Account, coin: string, target: number | null): Result<Account> {
  const p = a.positions[coin];
  if (!p) return { ok: false, error: 'No position.' };
  return { ok: true, value: { ...a, positions: { ...a.positions, [coin]: { ...p, target } } } };
}

/** What should happen to this position at this mark, if anything. Liquidation wins ties. */
export function triggerFor(p: Position, mark: number): PaperFillAction | null {
  const liq = liquidationPrice(p);
  if (p.side === 'long') {
    if (mark <= liq) return 'liquidation';
    if (p.stop != null && mark <= p.stop) return 'stop';
    if (p.target != null && mark >= p.target) return 'target';
  } else {
    if (mark >= liq) return 'liquidation';
    if (p.stop != null && mark >= p.stop) return 'stop';
    if (p.target != null && mark <= p.target) return 'target';
  }
  return null;
}

/** Size a position so that hitting the stop costs exactly `riskPct` of equity. */
export function notionalForRisk(equityUsd: number, riskPct: number, entry: number, stop: number): number {
  const dist = Math.abs(entry - stop) / entry;
  if (!(dist > 0)) return 0;
  return (equityUsd * riskPct / 100) / dist;
}
