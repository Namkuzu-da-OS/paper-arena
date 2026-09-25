import './style.css';
import {
  createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp,
} from 'lightweight-charts';
import { Feed, fetchCandles, fetchMeta, type Book, type Candle } from './hl';
import {
  closePosition, equity, liquidationPrice, moveStop, moveTarget, newAccount, notionalForRisk,
  openPosition, triggerFor, unrealized, TAKER_FEE, type Account, type Side,
} from './engine';
import { player, scoreHistory, MEDALS, type ScoredTrade } from './progress';
import { formatXp } from './xp';
import { playXpFanfare } from './xpSound';

// ── config ────────────────────────────────────────────────────────────────
const COINS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const FALLBACK_MAX_LEV: Record<string, number> = { BTC: 40, ETH: 25, SOL: 20, HYPE: 10 };
const INTERVALS = ['1m', '5m', '15m', '1h'];
/** Optional tip jar. Leave empty and the button stays hidden. */
const TIP_ADDRESS = '';
const STORE_KEY = 'paper-arena:v0';

// ── state ─────────────────────────────────────────────────────────────────
interface Saved { account: Account; sound: boolean; riskPct: number; coin: string; interval: string }

function load(): Saved {
  const fresh: Saved = { account: newAccount(), sound: true, riskPct: 1, coin: 'BTC', interval: '5m' };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fresh;
    return { ...fresh, ...JSON.parse(raw) };
  } catch {
    return fresh;
  }
}
function save(): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* private mode: play on, unsaved */ }
}

const S = load();
const marks: Record<string, number> = {};
const books: Record<string, Book> = {};
const maxLev: Record<string, number> = { ...FALLBACK_MAX_LEV };
let side: Side = 'long';
let connected = false;

// ── helpers ───────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const usd = (n: number, d = 2) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const px = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const d = n >= 1000 ? 1 : n >= 100 ? 2 : n >= 1 ? 3 : 5;
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const num = (el: HTMLInputElement): number | null => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) && v > 0 ? v : null;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

let toastTimer = 0;
function toast(msg: string, bad = false): void {
  const t = $('#toast');
  t.textContent = msg;
  t.className = bad ? 'show bad' : 'show';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = ''), 3200);
}

function announce(word: string): void {
  if (!S.sound || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(word);
    u.rate = 0.85; u.pitch = 0.6; u.volume = 0.9;
    speechSynthesis.speak(u);
  } catch { /* no voice is fine */ }
}

// ── layout ────────────────────────────────────────────────────────────────
$('#app').innerHTML = `
<header>
  <div class="logo">PAPER<span>ARENA</span></div>
  <nav id="coins"></nav>
  <div id="player"></div>
  <div class="hdr-actions">
    <button id="sound" class="ghost" title="Sound"></button>
    <button id="tip" class="ghost tip" hidden>DROP SOME DUST</button>
  </div>
</header>
<main>
  <section class="chart-wrap panel">
    <div class="chart-bar">
      <div id="ticker"></div>
      <div id="intervals"></div>
      <div id="conn" class="conn"></div>
    </div>
    <div id="chart"></div>
  </section>
  <section class="book panel">
    <h3>ORDER BOOK</h3>
    <div class="book-head"><span>PRICE</span><span>SIZE</span></div>
    <div id="asks"></div>
    <div id="spread"></div>
    <div id="bids"></div>
  </section>
  <section class="ticket panel">
    <div class="side-toggle">
      <button id="long" class="on">LONG</button>
      <button id="short">SHORT</button>
    </div>
    <label>LEVERAGE <b id="levv"></b>
      <input id="lev" type="range" min="1" step="1" value="5" />
    </label>
    <label>SIZE (USD NOTIONAL)<input id="size" type="number" min="0" step="10" placeholder="1000" /></label>
    <div class="row2">
      <label>STOP<input id="stop" type="number" step="any" placeholder="required for XP" /></label>
      <label>TARGET<input id="target" type="number" step="any" placeholder="optional" /></label>
    </div>
    <div class="row2 risk-row">
      <label>RISK / TRADE %<input id="risk" type="number" min="0.1" max="10" step="0.1" /></label>
      <button id="sizeRisk" class="ghost">SIZE TO RISK</button>
    </div>
    <div id="preview" class="preview"></div>
    <button id="place" class="place long">PLACE MARKET LONG</button>
    <p class="fine">Fills walk the live order book. Taker fee ≈ ${(TAKER_FEE * 100).toFixed(3)}%. Isolated margin.</p>
  </section>
  <section class="positions panel">
    <div class="tabs"><h3>POSITIONS</h3><div id="acct"></div></div>
    <div id="pos"></div>
  </section>
  <section class="history panel">
    <div class="tabs"><h3>MISSION LOG</h3><button id="reset" class="ghost small">RESET ACCOUNT</button></div>
    <div id="medals"></div>
    <div id="hist"></div>
  </section>
</main>
<footer>
  <p><b>PAPER TRADING ONLY.</b> No real money, no prizes, not financial advice. Education and practice.
  Market data: Hyperliquid public API. Not affiliated with or endorsed by Hyperliquid.
  <b>Nothing is collected</b>: your account lives only in this browser.
  Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView Lightweight Charts™</a>.
  Open source.</p>
</footer>
<div id="debrief" hidden></div>
<div id="toast"></div>
`;

// ── chart ─────────────────────────────────────────────────────────────────
const chartEl = $('#chart');
const chart: IChartApi = createChart(chartEl, {
  autoSize: true,
  layout: { background: { color: 'transparent' }, textColor: '#9aa0c8', fontFamily: 'JetBrains Mono, monospace' },
  grid: { vertLines: { color: 'rgba(120,110,200,0.08)' }, horzLines: { color: 'rgba(120,110,200,0.08)' } },
  rightPriceScale: { borderColor: 'rgba(120,110,200,0.25)' },
  timeScale: { borderColor: 'rgba(120,110,200,0.25)', timeVisible: true },
  crosshair: { mode: 0 },
});
const series: ISeriesApi<'Candlestick'> = chart.addSeries(CandlestickSeries, {
  upColor: '#39ff9c', downColor: '#ff3d7f', borderVisible: false,
  wickUpColor: '#39ff9c', wickDownColor: '#ff3d7f',
});
let lines: IPriceLine[] = [];
let lastBar: Candle | null = null;

async function loadChart(): Promise<void> {
  try {
    const bars = await fetchCandles(S.coin, S.interval);
    series.setData(bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
    lastBar = bars[bars.length - 1] ?? null;
    chart.timeScale().scrollToRealTime();
  } catch {
    toast('Could not load candles. Retrying on the next tick.', true);
  }
}

function drawLines(): void {
  for (const l of lines) series.removePriceLine(l);
  lines = [];
  const p = S.account.positions[S.coin];
  if (!p) return;
  const add = (price: number | null, color: string, title: string, style = 0) => {
    if (price == null || !Number.isFinite(price)) return;
    lines.push(series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
  };
  add(p.entry, '#c9c3ff', 'ENTRY');
  add(p.stop, '#ff3d7f', 'STOP', 2);
  add(p.target, '#39ff9c', 'TARGET', 2);
  add(liquidationPrice(p), '#ffb000', 'LIQ', 1);
}

// ── feed ──────────────────────────────────────────────────────────────────
let dirty = false;
function schedule(): void {
  if (dirty) return;
  dirty = true;
  // A timer, not requestAnimationFrame: rAF is paused in background tabs,
  // which froze the UI (not the engine) until the tab was looked at again.
  setTimeout(() => { dirty = false; renderLive(); }, 120);
}

const feed = new Feed({
  onStatus(c) { connected = c; renderConn(); },
  onMids(m) {
    for (const c of COINS) if (m[c]) marks[c] = m[c];
    checkTriggers();
    schedule();
  },
  onBook(coin, b) {
    books[coin] = b;
    if (coin === S.coin) schedule();
  },
  onCandle(coin, interval, c) {
    if (coin !== S.coin || interval !== S.interval) return;
    if (lastBar && c.time < lastBar.time) return;
    lastBar = c;
    series.update({ ...c, time: c.time as UTCTimestamp });
  },
});
feed.subscribe({ type: 'allMids' });
for (const c of COINS) feed.subscribe({ type: 'l2Book', coin: c });
feed.subscribe({ type: 'candle', coin: S.coin, interval: S.interval });

function checkTriggers(): void {
  for (const p of Object.values(S.account.positions)) {
    const m = marks[p.coin];
    if (!m) continue;
    const why = triggerFor(p, m);
    if (why) close(p.coin, why);
  }
}

// ── actions ───────────────────────────────────────────────────────────────
function switchCoin(coin: string): void {
  if (coin === S.coin) return;
  feed.unsubscribe({ type: 'candle', coin: S.coin, interval: S.interval });
  S.coin = coin;
  feed.subscribe({ type: 'candle', coin: S.coin, interval: S.interval });
  save();
  setupLeverage();
  loadChart().then(drawLines);
  renderAll();
}

function switchInterval(iv: string): void {
  if (iv === S.interval) return;
  feed.unsubscribe({ type: 'candle', coin: S.coin, interval: S.interval });
  S.interval = iv;
  feed.subscribe({ type: 'candle', coin: S.coin, interval: S.interval });
  save();
  loadChart().then(drawLines);
  renderIntervals();
}

function place(): void {
  const book = books[S.coin];
  if (!book) return toast('Waiting for the order book…', true);
  const res = openPosition(S.account, {
    coin: S.coin, side, notional: num($('#size')) ?? 0,
    leverage: +$<HTMLInputElement>('#lev').value, maxLeverage: maxLev[S.coin],
    stop: num($('#stop')), target: num($('#target')), riskPerTradePct: S.riskPct,
  }, book, marks);
  if (!res.ok) return toast(res.error, true);
  S.account = res.value.account;
  save();
  const noStop = num($('#stop')) == null;
  toast(`${side.toUpperCase()} ${S.coin} filled · slippage ${res.value.slippageBps.toFixed(1)} bps${noStop ? ' · NO STOP: this trade cannot earn full XP' : ''}`, noStop);
  drawLines();
  renderAll();
}

function close(coin: string, reason: Parameters<typeof closePosition>[4]): void {
  const r = closePosition(S.account, coin, books[coin], marks[coin], reason);
  if (!r) return;
  S.account = r.account;
  save();
  if (coin === S.coin) drawLines();
  const scored = scoreHistory(S.account.history);
  showDebrief(scored[scored.length - 1]);
  renderAll();
}

function setStop(coin: string, v: number | null): void {
  const r = moveStop(S.account, coin, v);
  if (!r.ok) return toast(r.error, true);
  const widened = r.value.positions[coin].stopWidenings > S.account.positions[coin].stopWidenings;
  S.account = r.value;
  save();
  if (widened) { toast('STOP WIDENED. That is recorded and it will cost you.', true); announce('Widened'); }
  else toast('Stop moved.');
  drawLines();
  renderAll();
}

function setTarget(coin: string, v: number | null): void {
  const r = moveTarget(S.account, coin, v);
  if (!r.ok) return toast(r.error, true);
  S.account = r.value;
  save();
  drawLines();
  renderAll();
}

// ── debrief ───────────────────────────────────────────────────────────────
const ANNOUNCE: Record<string, string> = {
  flawless: 'Excellent', solid: 'Impressive', disciplined: 'Iron will', loose: 'Sloppy', unstructured: 'No plan',
};

function showDebrief(s: ScoredTrade): void {
  const { trade: t, award: a, medals, xp } = s;
  const d = $('#debrief');
  const liquidated = t.exitReason === 'liquidation';
  const tick = (st: string) => (st === 'pass' ? '✓' : st === 'fail' ? '✗' : '?');
  d.innerHTML = `
    <div class="card grade-${a.grade}">
      <div class="card-kicker">MISSION DEBRIEF · ${t.coin} ${t.side.toUpperCase()} ${t.leverage}×</div>
      <div class="card-head">${esc(a.headline)}</div>
      <div class="card-xp">${formatXp(xp)}</div>
      <div class="card-sub">${esc(a.subtext)}</div>
      <div class="card-stats">
        <div><span>P&amp;L</span><b class="${t.realizedPnl >= 0 ? 'up' : 'dn'}">${usd(t.realizedPnl)}</b></div>
        <div><span>R</span><b>${t.rMultiple == null ? 'no stop' : t.rMultiple.toFixed(2) + 'R'}</b></div>
        <div><span>EXIT</span><b>${t.exitReason.toUpperCase()}</b></div>
      </div>
      <ul class="checks">${a.checks.map((c) => `<li class="${c.state}"><i>${tick(c.state)}</i>${esc(c.label)}</li>`).join('')}</ul>
      ${medals.length ? `<div class="card-medals">${medals.map((m) => `<span class="medal m-${m.key}" title="${esc(m.blurb)}">${m.name}</span>`).join('')}</div>` : ''}
      <div class="card-motto">${esc(a.motto)}</div>
      <button id="dismiss">CONTINUE</button>
    </div>`;
  d.hidden = false;
  $('#dismiss').onclick = () => (d.hidden = true);
  if (S.sound) playXpFanfare(a.grade);
  setTimeout(() => announce(liquidated ? 'Humiliation' : ANNOUNCE[a.grade]), 900);
}

// ── render ────────────────────────────────────────────────────────────────
function renderCoins(): void {
  $('#coins').innerHTML = COINS.map((c) => `
    <button data-coin="${c}" class="${c === S.coin ? 'on' : ''}${S.account.positions[c] ? ' has-pos' : ''}">
      ${c}<small id="mid-${c}">${px(marks[c])}</small>
    </button>`).join('');
  $('#coins').querySelectorAll('button').forEach((b) => (b.onclick = () => switchCoin(b.dataset.coin!)));
}

function renderIntervals(): void {
  $('#intervals').innerHTML = INTERVALS.map((iv) => `<button data-iv="${iv}" class="${iv === S.interval ? 'on' : ''}">${iv}</button>`).join('');
  $('#intervals').querySelectorAll('button').forEach((b) => (b.onclick = () => switchInterval(b.dataset.iv!)));
}

function renderConn(): void {
  const c = $('#conn');
  c.textContent = connected ? '● LIVE' : '● RECONNECTING';
  c.className = `conn ${connected ? 'ok' : 'bad'}`;
}

function renderPlayer(): void {
  const p = player(scoreHistory(S.account.history));
  const span = p.nextLevelXp - p.levelFloorXp;
  const pct = span > 0 ? ((p.totalXp - p.levelFloorXp) / span) * 100 : 0;
  $('#player').innerHTML = `
    <div class="lvl">LV <b>${p.level}</b></div>
    <div class="xpbar"><div style="width:${pct.toFixed(1)}%"></div><span>${Math.round(p.totalXp)} / ${p.nextLevelXp} XP</span></div>
    <div class="rank r-${p.rank}">${p.rank}</div>`;
  $('#medals').innerHTML = Object.entries(MEDALS).map(([k, m]) =>
    `<span class="medal m-${k} ${p.medalCounts[k] ? '' : 'dim'}" title="${esc(m.blurb)}">${m.name} <b>${p.medalCounts[k] ?? 0}</b></span>`).join('');
}

function renderHistory(): void {
  const scored = scoreHistory(S.account.history).slice(-25).reverse();
  $('#hist').innerHTML = scored.length ? `<table>
    <tr><th>COIN</th><th>SIDE</th><th>EXIT</th><th>P&amp;L</th><th>R</th><th>GRADE</th><th>XP</th></tr>
    ${scored.map((s) => `<tr>
      <td>${s.trade.coin}</td><td class="${s.trade.side}">${s.trade.side.toUpperCase()} ${s.trade.leverage}×</td>
      <td>${s.trade.exitReason}</td>
      <td class="${s.trade.realizedPnl >= 0 ? 'up' : 'dn'}">${usd(s.trade.realizedPnl)}</td>
      <td>${s.trade.rMultiple == null ? '—' : s.trade.rMultiple.toFixed(2)}</td>
      <td class="g-${s.award.grade}">${s.award.headline}</td><td><b>${Math.round(s.xp)}</b></td></tr>`).join('')}
  </table>` : `<p class="empty">No missions yet. Set a stop, take a trade, and see what the system thinks of your process.</p>`;
}

function renderPositions(): void {
  const ps = Object.values(S.account.positions);
  const eq = equity(S.account, marks);
  const pnl = eq - S.account.startingCash;
  $('#acct').innerHTML = `EQUITY <b>${usd(eq)}</b> · FREE <b>${usd(S.account.cash)}</b> · <span class="${pnl >= 0 ? 'up' : 'dn'}">${usd(pnl)}</span>`;
  const host = $('#pos');
  // Don't rebuild while the user is typing a new stop/target into this table.
  if (host.contains(document.activeElement) && ps.length === host.querySelectorAll('tr[data-coin]').length) {
    for (const p of ps) {
      const row = host.querySelector(`tr[data-coin="${p.coin}"]`);
      if (!row) continue;
      const u = unrealized(p, marks[p.coin] ?? p.entry);
      (row.querySelector('.mark') as HTMLElement).textContent = px(marks[p.coin]);
      const ue = row.querySelector('.upnl') as HTMLElement;
      ue.textContent = usd(u); ue.className = `upnl ${u >= 0 ? 'up' : 'dn'}`;
    }
    return;
  }
  host.innerHTML = ps.length ? `<table>
    <tr><th>COIN</th><th>SIDE</th><th>SIZE</th><th>ENTRY</th><th>MARK</th><th>LIQ</th><th>uP&amp;L</th><th>STOP</th><th>TARGET</th><th></th></tr>
    ${ps.map((p) => {
      const u = unrealized(p, marks[p.coin] ?? p.entry);
      return `<tr data-coin="${p.coin}">
        <td>${p.coin}</td><td class="${p.side}">${p.side.toUpperCase()} ${p.leverage}×</td>
        <td>${usd(p.qty * p.entry, 0)}</td><td>${px(p.entry)}</td><td class="mark">${px(marks[p.coin])}</td>
        <td class="liq">${px(liquidationPrice(p))}</td>
        <td class="upnl ${u >= 0 ? 'up' : 'dn'}">${usd(u)}</td>
        <td><input class="edit" data-k="stop" value="${p.stop ?? ''}" placeholder="none"/>${p.stopWidenings ? `<em title="stop widenings">W${p.stopWidenings}</em>` : ''}</td>
        <td><input class="edit" data-k="target" value="${p.target ?? ''}" placeholder="none"/></td>
        <td><button class="close" data-close="${p.coin}">CLOSE</button></td></tr>`;
    }).join('')}
  </table>` : `<p class="empty">Flat. Pick a coin, set a stop, and size it to your risk.</p>`;
  host.querySelectorAll<HTMLButtonElement>('button[data-close]').forEach((b) => (b.onclick = () => close(b.dataset.close!, 'sell')));
  host.querySelectorAll<HTMLInputElement>('input.edit').forEach((inp) => {
    const commit = () => {
      const coin = inp.closest('tr')!.getAttribute('data-coin')!;
      const v = inp.value.trim() === '' ? null : parseFloat(inp.value);
      if (v != null && !(v > 0)) return toast('Enter a price.', true);
      const cur = inp.dataset.k === 'stop' ? S.account.positions[coin]?.stop : S.account.positions[coin]?.target;
      if (v === (cur ?? null)) return;
      inp.dataset.k === 'stop' ? setStop(coin, v) : setTarget(coin, v);
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { commit(); inp.blur(); } };
    inp.onblur = commit;
  });
}

function renderBook(): void {
  const b = books[S.coin];
  if (!b) return;
  const rows = 11;
  const asks = b.asks.slice(0, rows);
  const bids = b.bids.slice(0, rows);
  const maxSz = Math.max(...asks.map((l) => l[1]), ...bids.map((l) => l[1]), 1e-9);
  const row = (l: [number, number], cls: string) =>
    `<div class="lv ${cls}"><i style="width:${(l[1] / maxSz * 100).toFixed(1)}%"></i><span>${px(l[0])}</span><span>${l[1].toFixed(3)}</span></div>`;
  $('#asks').innerHTML = asks.slice().reverse().map((l) => row(l, 'ask')).join('');
  $('#bids').innerHTML = bids.map((l) => row(l, 'bid')).join('');
  if (asks[0] && bids[0]) {
    const sp = asks[0][0] - bids[0][0];
    $('#spread').textContent = `SPREAD ${px(sp)} · ${(sp / asks[0][0] * 10_000).toFixed(2)} bps`;
  }
}

function renderTicker(): void {
  $('#ticker').innerHTML = `<b>${S.coin}-PERP</b> <span>${px(marks[S.coin])}</span>`;
  for (const c of COINS) {
    const el = document.getElementById(`mid-${c}`);
    if (el) el.textContent = px(marks[c]);
  }
}

function renderPreview(): void {
  const mid = marks[S.coin];
  const size = num($('#size'));
  const lev = +$<HTMLInputElement>('#lev').value;
  const stop = num($('#stop'));
  const target = num($('#target'));
  const out: string[] = [];
  if (mid && size) {
    const margin = size / lev;
    const qty = size / mid;
    const liq = liquidationPrice({ side, qty, entry: mid, margin, maxLeverage: maxLev[S.coin] });
    out.push(`<div><span>Margin</span><b>${usd(margin)}</b></div>`);
    out.push(`<div><span>Fee</span><b>${usd(size * TAKER_FEE)}</b></div>`);
    out.push(`<div><span>Liq. price</span><b class="liq">${px(liq)}</b></div>`);
    if (stop) {
      const risk = Math.abs(mid - stop) * qty;
      const eq = equity(S.account, marks);
      const pct = (risk / eq) * 100;
      out.push(`<div><span>Risk at stop</span><b class="${pct > S.riskPct ? 'dn' : 'up'}">${usd(risk)} · ${pct.toFixed(2)}%</b></div>`);
      if (target) out.push(`<div><span>Reward : Risk</span><b>${(Math.abs(target - mid) / Math.abs(mid - stop)).toFixed(2)}R</b></div>`);
    } else {
      out.push(`<div class="warn">No stop set. Without a stop there is no R, so the trade can't earn outcome XP.</div>`);
    }
  }
  $('#preview').innerHTML = out.join('');
}

function renderLive(): void {
  renderTicker();
  renderBook();
  renderPositions();
  renderPreview();
}

function renderAll(): void {
  renderCoins();
  renderIntervals();
  renderConn();
  renderPlayer();
  renderHistory();
  renderLive();
  $('#sound').textContent = S.sound ? '🔊' : '🔈';
}

// ── ticket wiring ─────────────────────────────────────────────────────────
function setupLeverage(): void {
  const lev = $<HTMLInputElement>('#lev');
  lev.max = String(maxLev[S.coin]);
  if (+lev.value > maxLev[S.coin]) lev.value = String(maxLev[S.coin]);
  $('#levv').textContent = `${lev.value}× (max ${maxLev[S.coin]}×)`;
}

function setSide(s: Side): void {
  side = s;
  $('#long').className = s === 'long' ? 'on' : '';
  $('#short').className = s === 'short' ? 'on' : '';
  const b = $('#place');
  b.textContent = `PLACE MARKET ${s.toUpperCase()}`;
  b.className = `place ${s}`;
  renderPreview();
}

$('#long').onclick = () => setSide('long');
$('#short').onclick = () => setSide('short');
$('#lev').oninput = () => { setupLeverage(); renderPreview(); };
['#size', '#stop', '#target'].forEach((s) => ($(s).oninput = renderPreview));
const riskEl = $<HTMLInputElement>('#risk');
riskEl.value = String(S.riskPct);
riskEl.oninput = () => {
  const v = parseFloat(riskEl.value);
  if (v > 0 && v <= 10) { S.riskPct = v; save(); renderPreview(); }
};
$('#sizeRisk').onclick = () => {
  const mid = marks[S.coin];
  const stop = num($('#stop'));
  if (!mid || !stop) return toast('Set a stop first. Sizing starts from where you are wrong.', true);
  const want = notionalForRisk(equity(S.account, marks), S.riskPct, mid, stop);
  const lev = +$<HTMLInputElement>('#lev').value;
  // What the free collateral can actually carry at this leverage, fee included.
  const cap = (S.account.cash * 0.98) / (1 / lev + TAKER_FEE);
  const n = Math.min(want, cap);
  $<HTMLInputElement>('#size').value = n.toFixed(0);
  if (want > cap) {
    toast(`Full ${S.riskPct}% risk needs ${usd(want, 0)} notional; your collateral carries ${usd(cap, 0)} at ${lev}×. Sized down. Risk less than planned is fine.`, true);
  }
  renderPreview();
};
$('#place').onclick = place;
$('#sound').onclick = () => { S.sound = !S.sound; save(); renderAll(); };

let resetArmed = 0;
$('#reset').onclick = () => {
  const b = $('#reset');
  if (Date.now() - resetArmed < 3000) {
    S.account = newAccount();
    save();
    drawLines();
    renderAll();
    b.textContent = 'RESET ACCOUNT';
    toast('Fresh account: $10,000 paper. XP history cleared.');
  } else {
    resetArmed = Date.now();
    b.textContent = 'CLICK AGAIN TO WIPE';
    setTimeout(() => (b.textContent = 'RESET ACCOUNT'), 3000);
  }
};

if (TIP_ADDRESS) {
  const tip = $<HTMLButtonElement>('#tip');
  tip.hidden = false;
  tip.onclick = async () => {
    try { await navigator.clipboard.writeText(TIP_ADDRESS); toast('SOL address copied. Any amount of dust keeps the arena lit. Thank you.'); }
    catch { toast(`SOL: ${TIP_ADDRESS}`); }
  };
}

// ── boot ──────────────────────────────────────────────────────────────────
setupLeverage();
renderAll();
loadChart().then(drawLines);
fetchMeta(COINS).then((m) => {
  for (const c of COINS) if (m[c]) maxLev[c] = m[c].maxLeverage;
  setupLeverage();
}).catch(() => { /* fallback caps are already in place */ });
