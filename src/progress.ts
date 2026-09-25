/**
 * Progression, derived on read from closed trades. There is no XP counter to
 * keep in sync: replay the history and you get the same player.
 *
 * Level never drops (accumulated discipline). Rank is current form over the
 * last 10 trades and CAN fall: you can grind trades, you can't fake discipline.
 */

import { scoreTrade, type XpAward } from './xp';
import type { ClosedTrade } from './engine';

export interface Medal { key: string; name: string; blurb: string; xp: number }

export const MEDALS: Record<string, Omit<Medal, 'key'>> = {
  EXCELLENT: { name: 'EXCELLENT', blurb: 'Flawless execution', xp: 0 },
  STOP_HONORED: { name: 'STOP HONORED', blurb: 'Took the stop as written', xp: 0 },
  SNIPER: { name: 'SNIPER', blurb: 'Hit the target at 2R or better', xp: 0 },
  IRON_WILL: { name: 'IRON WILL', blurb: 'A disciplined loss', xp: 0 },
  HUMILIATION: { name: 'HUMILIATION', blurb: 'Liquidated', xp: 0 },
  TILT: { name: 'TILT', blurb: 'Re-entered within 60s of a loss. -10 XP', xp: -10 },
  WIDENED: { name: 'WIDENED', blurb: 'Moved the stop away from the market', xp: 0 },
};

export interface ScoredTrade { trade: ClosedTrade; award: XpAward; medals: Medal[]; xp: number }

const medal = (key: string): Medal => ({ key, ...MEDALS[key] });

export function scoreHistory(history: ClosedTrade[]): ScoredTrade[] {
  const out: ScoredTrade[] = [];
  for (let i = 0; i < history.length; i++) {
    const t = history[i];
    const award = scoreTrade({
      realizedPnl: t.realizedPnl, rMultiple: t.rMultiple, plannedRisk: t.plannedRisk,
      initialStop: t.initialStop, target: t.target, exitReason: t.exitReason,
      stopWidenings: t.stopWidenings, equityAtEntry: t.equityAtEntry, riskPerTradePct: t.riskPerTradePct,
    });
    const medals: Medal[] = [];
    if (award.grade === 'flawless') medals.push(medal('EXCELLENT'));
    if (t.exitReason === 'stop' && t.stopWidenings === 0) medals.push(medal('STOP_HONORED'));
    if (t.exitReason === 'target' && (t.rMultiple ?? 0) >= 2) medals.push(medal('SNIPER'));
    if (award.grade === 'disciplined') medals.push(medal('IRON_WILL'));
    if (t.exitReason === 'liquidation') medals.push(medal('HUMILIATION'));
    if (t.stopWidenings > 0) medals.push(medal('WIDENED'));
    const prevLoss = history.slice(0, i).reverse().find((p) => p.realizedPnl < 0);
    if (prevLoss && t.openedAt - prevLoss.closedAt < 60_000 && t.openedAt >= prevLoss.closedAt) {
      medals.push(medal('TILT'));
    }
    const xp = Math.max(0, award.total + medals.reduce((s, m) => s + m.xp, 0));
    out.push({ trade: t, award, medals, xp });
  }
  return out;
}

export const RANKS = ['RECRUIT', 'SOLDIER', 'VETERAN', 'SENTINEL', 'LEGEND'] as const;

export interface Player {
  totalXp: number;
  level: number;
  levelFloorXp: number;
  nextLevelXp: number;
  rank: string;
  formXp: number | null;
  trades: number;
  medalCounts: Record<string, number>;
}

const xpForLevel = (lvl: number) => 40 * (lvl - 1) ** 2;

export function player(scored: ScoredTrade[]): Player {
  const totalXp = scored.reduce((s, x) => s + x.xp, 0);
  let level = 1;
  while (xpForLevel(level + 1) <= totalXp) level++;
  const recent = scored.slice(-10);
  const formXp = recent.length >= 3 ? recent.reduce((s, x) => s + x.xp, 0) / recent.length : null;
  const rank = formXp == null ? 'UNRANKED'
    : formXp >= 85 ? 'LEGEND' : formXp >= 70 ? 'SENTINEL' : formXp >= 55 ? 'VETERAN'
    : formXp >= 40 ? 'SOLDIER' : 'RECRUIT';
  const medalCounts: Record<string, number> = {};
  for (const s of scored) for (const m of s.medals) medalCounts[m.key] = (medalCounts[m.key] ?? 0) + 1;
  return {
    totalXp, level, levelFloorXp: xpForLevel(level), nextLevelXp: xpForLevel(level + 1),
    rank, formXp, trades: scored.length, medalCounts,
  };
}
