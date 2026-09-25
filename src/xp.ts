/**
 * Discipline XP — what a closed trade earns.
 *
 * The one rule the whole system rests on: **XP is paid for BEHAVIOUR, not for
 * money.** A losing trade that set a stop, sized inside its own rule and
 * honoured that stop out-earns a bigger winner taken with no plan — by about
 * ten to one. That is deliberate. Paying XP for dollars would gamify exactly
 * the habits that empty an account (overtrading, chasing, widening a stop that
 * is about to fire), and the engine already records enough to score the habits
 * instead.
 *
 * Two structural consequences worth stating, because they are the design:
 *
 *  1. **No stop → no R → no outcome bonus, ever.** The outcome component is
 *     the only part that looks at the result at all, and it needs `rMultiple`,
 *     which needs a risk denominator, which needs a stop. So the system is
 *     mechanically incapable of paying out for a lucky win. That is not a
 *     penalty bolted on; it falls out of refusing to invent an R.
 *  2. **Only derivable checks exist here.** A mockup can print "emotional
 *     control" or "exited randomly"; this cannot. `exitReason: 'sell'` means a
 *     MANUAL close, which is not the same as a random one, and no field in this
 *     engine measures anyone's composure. Every check below maps to a real stored
 *     value, and that restraint is the reason the number is worth anything.
 *
 * Pure by construction: it takes a record, not an account, and touches no
 * store. Progression is DERIVED from closed trades on read — there is no XP
 * counter to keep and nothing to persist on a price tick.
 */

/**
 * How a position went flat. Copied from the original engine, plus
 * `liquidation`, which a leveraged perp can do and a cash account cannot.
 */
export type PaperFillAction = 'target' | 'stop' | 'trailingStop' | 'sell' | 'expire' | 'liquidation';

/** Everything the score is allowed to look at. */
export interface ClosedTradeFacts {
  /** Realised dollars for the whole flat-to-flat episode. */
  realizedPnl: number;
  /**
   * P&L in units of the risk originally taken. **Null whenever there was no
   * stop** — see `scoreTrade`, which re-imposes that rather than trusting it.
   */
  rMultiple: number | null;
  /** |entry − initialStop| × qty × multiplier. Null with no stop. */
  plannedRisk: number | null;
  /** The stop as first defined. Never ratchets, so it is the risk truly taken. */
  initialStop: number | null;
  target: number | null;
  /** The action on the fill that took the episode flat. */
  exitReason: PaperFillAction;
  /**
   * Times the stop moved AWAY from the market. Trailing it closer is free.
   *
   * **Null means NOT RECORDED, which is not the same as zero.** A trade
   * imported from somewhere that never tracked stop moves genuinely cannot know. Unknown does not
   * cost the trade any XP (absence of evidence is not evidence of widening),
   * but it must never render as a green "no stop widening" tick — see
   * `XpCheckState`. Live closes pass the real number.
   */
  stopWidenings: number | null;
  /** Account equity when the episode opened. Omit when not cheaply known. */
  equityAtEntry?: number;
  /** The trader's OWN max-risk-per-trade rule, in percent. */
  riskPerTradePct?: number;
}

export type XpGrade = 'flawless' | 'disciplined' | 'solid' | 'loose' | 'unstructured';

export interface XpComponents {
  /** Was the trade planned at all? Stop and target defined up front. */
  process: number;
  /** Was the size inside the trader's own rule? */
  risk: number;
  /** How did it end — as written, or improvised? */
  execution: number;
  /** Stop integrity. Widening under pressure is the cardinal sin. */
  discipline: number;
  /**
   * The only component that looks at the result, and the smallest. Requires an
   * R, so it is unreachable without a stop.
   */
  outcome: number;
}

/**
 * `unknown` is a first-class answer, not a failure. The app would rather say
 * "not recorded" than print a tick it cannot stand behind.
 */
export type XpCheckState = 'pass' | 'fail' | 'unknown';

export interface XpCheck {
  key: string;
  label: string;
  state: XpCheckState;
}

export interface XpAward {
  total: number;
  grade: XpGrade;
  headline: string;
  subtext: string;
  /**
   * The line the card prints under the XP. Short, declarative, and the same
   * for every trade of a grade — it is the system's opinion, not a comment on
   * this particular trade, and it is what stops a disciplined LOSS reading as
   * a consolation prize.
   */
  motto: string;
  components: XpComponents;
  /** Every one of these maps to a stored field. Nothing is inferred. */
  checks: XpCheck[];
}

// ── component ceilings ──────────────────────────────────────────────────
// Process-side sums to 85; outcome adds at most 15. A perfect process trade
// that also ran is 100; a perfect process trade that lost is 70; a formless
// win is single digits.
export const MAX_PROCESS = 25;
export const MAX_RISK = 20;
export const MAX_EXECUTION = 20;
export const MAX_DISCIPLINE = 20;
export const MAX_OUTCOME = 15;
export const MAX_XP = MAX_PROCESS + MAX_RISK + MAX_EXECUTION + MAX_DISCIPLINE + MAX_OUTCOME;

/** Each widening costs this much discipline. Three of them zero it out. */
const WIDENING_COST = 7;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Was the risk taken inside the trader's own stated rule? */
function withinOwnRule(f: ClosedTradeFacts): boolean | null {
  if (!isNum(f.plannedRisk) || f.plannedRisk <= 0) return null;
  if (!isNum(f.equityAtEntry) || f.equityAtEntry <= 0) return null;
  if (!isNum(f.riskPerTradePct) || f.riskPerTradePct <= 0) return null;
  // 2% of the risk budget as slack: a position sized to exactly 1% off the
  // mid fills a few cents away on the live book, and that is not a breach.
  return f.plannedRisk <= (f.riskPerTradePct / 100) * f.equityAtEntry * 1.02;
}

export function scoreTrade(facts: ClosedTradeFacts): XpAward {
  const hasStop = isNum(facts.initialStop);
  const hasTarget = isNum(facts.target);
  const widenKnown = isNum(facts.stopWidenings);
  const widenings = widenKnown ? Math.max(0, Math.trunc(facts.stopWidenings as number) || 0) : 0;
  // Re-imposed, not trusted: an R without a stop has no denominator, and a
  // caller handing one over must not be able to buy the outcome bonus with it.
  const r = hasStop && isNum(facts.rMultiple) ? facts.rMultiple : null;
  const inRule = withinOwnRule(facts);

  const process = (hasStop ? 15 : 0) + (hasTarget ? 10 : 0);

  const risk = !isNum(facts.plannedRisk) || facts.plannedRisk <= 0
    ? 0
    : inRule === false ? 10 : MAX_RISK;

  let execution: number;
  switch (facts.exitReason) {
    case 'target': execution = 20; break;
    case 'stop': case 'trailingStop': execution = hasStop ? 15 : 6; break;
    case 'expire': execution = 4; break;
    case 'liquidation': execution = 0; break;
    default: execution = hasStop && hasTarget ? 12 : hasStop ? 9 : 4;
  }

  // You cannot widen a stop you never set — but that buys almost nothing,
  // otherwise "no plan" would score as "perfect discipline".
  const discipline = hasStop
    ? Math.max(0, MAX_DISCIPLINE - WIDENING_COST * widenings)
    : 3;

  let outcome = 0;
  if (r != null && r > 0) outcome = r >= 3 ? 15 : r >= 2 ? 10 : r >= 1 ? 6 : 3;

  const components: XpComponents = { process, risk, execution, discipline, outcome };
  const total = process + risk + execution + discipline + outcome;

  const won = facts.realizedPnl > 0;
  // A grade is a claim about BEHAVIOUR, so the two top grades are gated on the
  // behaviour as well as the total. Scoring them off the sum alone let a trade
  // with a widened stop still read FLAWLESS (25+20+20+13+15 = 93), which is the
  // system flattering exactly the habit it exists to discourage. Caught by
  // xp.test.ts; keep the gate if you ever retune the ceilings.
  // Two gates, and both were added because the sum alone got it wrong:
  // a widened stop still totalled 93, and a position at FOUR TIMES the
  // trader's own risk rule still totalled 90. Either would have printed
  // FLAWLESS EXECUTION over the exact behaviour this system exists to
  // discourage. `inRule === null` means we could not check (no equity or no
  // rule on file) and must not be held against the trade.
  // Unknown widenings count as clean for GRADING — punishing a historical row
  // for a record the mirror never kept would make every pre-existing trade
  // look sloppy. The honesty lives in the displayed check, not in the score.
  const cleanStop = hasStop && widenings === 0;
  const sizeOk = inRule !== false;
  const liquidated = facts.exitReason === 'liquidation';
  let grade: XpGrade;
  if (liquidated) grade = 'unstructured';
  else if (total >= 85 && cleanStop && sizeOk) grade = 'flawless';
  else if (total >= 60 && cleanStop) grade = won ? 'solid' : 'disciplined';
  else if (total >= 30) grade = 'loose';
  else grade = 'unstructured';

  const headline = liquidated ? 'LIQUIDATED'
    : grade === 'flawless' ? 'FLAWLESS EXECUTION'
    : grade === 'disciplined' ? 'DISCIPLINED LOSS'
    : grade === 'solid' ? 'SOLID EXECUTION'
    : grade === 'loose' ? 'LOOSE EXECUTION'
    : won ? 'UNSTRUCTURED WIN' : 'UNSTRUCTURED LOSS';

  const motto = liquidated ? 'THE MARKET TOOK THE ACCOUNT. SIZE DOWN.'
    : grade === 'flawless' ? 'GREAT TRADES BUILD GREATER TRADERS.'
    : grade === 'disciplined' ? 'LOSSES ARE TUITION.'
    : grade === 'solid' ? 'PROCESS COMPOUNDS.'
    : grade === 'loose' ? (won ? 'IT WORKED. IT WAS NOT THE PLAN.' : 'THE PLAN BENT. THE MARKET NOTICED.')
    : 'LUCK IS NOT A STRATEGY.';

  const subtext = liquidated ? 'Margin gone. The stop was the exit you skipped.'
    : grade === 'flawless' ? 'Plan. Execute. Repeat.'
    : grade === 'disciplined' ? 'Same process. Different outcome.'
    : grade === 'solid' ? 'The plan held.'
    : grade === 'loose' ? (won ? 'It worked. It was not the plan.' : 'You changed the plan mid-trade.')
    : won ? 'Got lucky. No edge.' : 'No plan to fall back on.';

  const yn = (ok: boolean): XpCheckState => (ok ? 'pass' : 'fail');
  const reachedStop = facts.exitReason === 'stop' || facts.exitReason === 'trailingStop';

  const checks: XpCheck[] = [
    { key: 'stopSet', label: 'Stop set before entry', state: yn(hasStop) },
    { key: 'targetSet', label: 'Target defined', state: yn(hasTarget) },
    {
      key: 'noWidening',
      label: 'No stop widening',
      // Unknown only when a stop existed to widen; with no stop at all the
      // honest answer is a plain fail, not a shrug.
      state: !hasStop ? 'fail' : widenKnown ? yn(widenings === 0) : 'unknown',
    },
    { key: 'targetHit', label: 'Target hit', state: yn(facts.exitReason === 'target') },
    {
      key: 'stopHonored',
      label: 'Stop honored',
      // Only meaningful on a trade that actually REACHED its stop — a winner
      // never tested it, so a tick there would be flattery. And a trade that
      // stopped out with no widening record cannot be confirmed either.
      state: !hasStop || !reachedStop ? 'fail' : widenKnown ? yn(widenings === 0) : 'unknown',
    },
  ];
  if (inRule != null) {
    checks.push({ key: 'sizeInRule', label: 'Planned risk respected', state: yn(inRule) });
  }

  return { total, grade, headline, subtext, motto, components, checks };
}

/** "+52 XP" */
export const formatXp = (total: number): string => `+${Math.round(total)} XP`;
