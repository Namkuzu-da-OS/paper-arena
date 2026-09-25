# PAPER ARENA

**A free paper-trading arena for perpetual futures. You earn XP for discipline, not for profit.**

Live prices, a real order book, leverage and liquidation, and a scoring system that pays you for trading
*like a professional*: a stop set before entry, size inside your own risk rule, and a plan you
honoured. A losing trade taken by the book out-earns a lucky win with no stop.

> Paper trading only. No real money, no prizes, not financial advice.

## What makes it different

- **Realistic fills.** Market orders walk the live order book, so size moves your price. Every fill pays a
  taker fee. Most paper trading fills at the last price, and that's a lie.
- **Isolated margin with liquidation.** Your liquidation price comes from the coin's maintenance margin. Hit it
  and the margin is gone.
- **Discipline XP.** Every closed trade is graded on process:
  - Was there a stop?
  - Was there a target?
  - Was the size inside your rule?
  - Did the trade end as written?
  - Was the stop widened?

  **No stop → no R → no outcome bonus, ever.** The system is mechanically incapable of paying for luck.
- **Arena mechanics.** Levels never drop; rank is current form and *can* fall. Medals: EXCELLENT, STOP HONORED, SNIPER, IRON WILL,
  and the penalties HUMILIATION (liquidated), TILT (re-entered within 60s of a loss) and WIDENED (moved your stop
  away from the market). There's an original synthesized fanfare per grade.
- **Private by default.** Your account lives in your browser. Nothing is collected.

## Run it

```bash
npm install
npm run dev
```

Market data comes from Hyperliquid's public API (read-only, no key). Paper Arena is **not affiliated with or endorsed by
Hyperliquid.** Charts are by [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/).

## Roadmap

- [x] v0: live BTC/ETH/SOL/HYPE, book-walk fills, leverage, liquidation, stops/targets, Discipline XP, medals, local save
- [ ] Shareable mission-debrief cards
- [ ] Bring-your-own-data connectors (read-only)
- [ ] Ranked seasons, duels, clan ladders, replays (needs a server-side engine; a browser engine can be edited, so public leaderboards wait for it)
- [ ] Bot and agent API: plug a bot or AI agent in and it gets scored like a human
- [ ] Graduation: earn it on discipline, then score your real trades the same way

## License

MIT
