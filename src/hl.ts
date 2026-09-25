/**
 * Market data from Hyperliquid's public API. Read-only: no key, no account,
 * nothing is ever sent except subscription requests.
 *
 * REST:      POST https://api.hyperliquid.xyz/info
 * WebSocket: wss://api.hyperliquid.xyz/ws
 */

const INFO = 'https://api.hyperliquid.xyz/info';
const WS = 'wss://api.hyperliquid.xyz/ws';

export type Level = [px: number, sz: number];
export interface Book { bids: Level[]; asks: Level[]; time: number }
export interface Candle { time: number; open: number; high: number; low: number; close: number }
export interface CoinMeta { name: string; maxLeverage: number; szDecimals: number }

async function info<T>(body: unknown): Promise<T> {
  const r = await fetch(INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Hyperliquid info ${r.status}`);
  return r.json() as Promise<T>;
}

export async function fetchMeta(coins: string[]): Promise<Record<string, CoinMeta>> {
  const d = await info<{ universe: CoinMeta[] }>({ type: 'meta' });
  const out: Record<string, CoinMeta> = {};
  for (const u of d.universe) if (coins.includes(u.name)) out[u.name] = u;
  return out;
}

interface RawCandle { t: number; o: string; h: string; l: string; c: string }

const toCandle = (k: RawCandle): Candle => ({
  time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c,
});

export const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000,
};

export async function fetchCandles(coin: string, interval: string, bars = 300): Promise<Candle[]> {
  const endTime = Date.now();
  const startTime = endTime - bars * INTERVAL_MS[interval];
  const d = await info<RawCandle[]>({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } });
  return d.map(toCandle);
}

type Sub =
  | { type: 'allMids' }
  | { type: 'l2Book'; coin: string }
  | { type: 'candle'; coin: string; interval: string };

export interface FeedHandlers {
  onMids(mids: Record<string, number>): void;
  onBook(coin: string, book: Book): void;
  onCandle(coin: string, interval: string, c: Candle): void;
  onStatus(connected: boolean): void;
}

/**
 * One socket, auto-reconnecting. Subscriptions are remembered and replayed on
 * every reconnect, so callers never have to care that the socket dropped.
 */
export class Feed {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Sub>();
  private h: FeedHandlers;
  private retry = 0;

  constructor(h: FeedHandlers) {
    this.h = h;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(WS);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.h.onStatus(true);
      for (const s of this.subs.values()) this.send('subscribe', s);
    };
    ws.onclose = () => {
      this.h.onStatus(false);
      const wait = Math.min(15_000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.open(), wait);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => this.handle(ev.data as string);
  }

  private send(method: 'subscribe' | 'unsubscribe', subscription: Sub): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method, subscription }));
    }
  }

  subscribe(s: Sub): void {
    const k = JSON.stringify(s);
    if (this.subs.has(k)) return;
    this.subs.set(k, s);
    this.send('subscribe', s);
  }

  unsubscribe(s: Sub): void {
    const k = JSON.stringify(s);
    if (!this.subs.delete(k)) return;
    this.send('unsubscribe', s);
  }

  private handle(raw: string): void {
    let msg: { channel?: string; data?: any };
    try { msg = JSON.parse(raw); } catch { return; }
    const d = msg.data;
    switch (msg.channel) {
      case 'allMids': {
        const mids: Record<string, number> = {};
        for (const [k, v] of Object.entries(d.mids as Record<string, string>)) mids[k] = +v;
        this.h.onMids(mids);
        break;
      }
      case 'l2Book': {
        const lv = d.levels as { px: string; sz: string }[][];
        const conv = (side: { px: string; sz: string }[]): Level[] => side.map((l) => [+l.px, +l.sz]);
        this.h.onBook(d.coin, { bids: conv(lv[0]), asks: conv(lv[1]), time: d.time });
        break;
      }
      case 'candle':
        this.h.onCandle(d.s, d.i, toCandle(d));
        break;
    }
  }
}
