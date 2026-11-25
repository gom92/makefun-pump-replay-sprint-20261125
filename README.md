# makefun-pump-replay-sprint-20261125

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/gom92/makefun-pump-replay-sprint-20261125/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/gom92/makefun-pump-replay-sprint-20261125/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Dawn Dip Reversion — a dip-reversion paper-trading bot for pump.fun bonding curves, built for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. One Node program (`main.ts`) that paper-trades 10 SOL on a 24h pump.fun replay; the house ranks entries by net PnL.

## Strategy

Most fresh launches dump, but a coin that already ran up 80% off launch, gave back a quarter of its peak, and whose tape has just turned net-buyer again is often a bounce, not a burial. This bot buys that dip — 0.15 SOL per coin — only once the price has stopped falling (no more than a 1% drop over the last 30 slots), then exits on a take-profit (+35%), a stop-loss (-15%), a trailing stop (arms at +18%, sells on a 10% pullback), a 400-slot hold cap, or 80 slots of silence. A coin must print a new peak 10% above the old one before it can be bought again.

On the kit's dev window it scores **+0.23 SOL net PnL over 49 coins (22 wins), max drawdown 1.5%**, and stays positive at 2x fees. The final window is fresh data, so nothing is promised — but the parameters sit in a flat, robust region, not on a knife edge.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`. Zero dependencies, erasable TypeScript only — no build, no install. `vendor/makefun-bot.ts` is the kit's protocol shim, copied byte-identical.

## Files

- `main.ts` — entrypoint: wires the strategy to the harness shim.
- `strategy.ts` — the Dawn Dip Reversion strategy (tape book, position book, dip entry bar, exits).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim (vendored, not authored).

---

<sub>Entered on [make.fun](https://make.fun/?ref=radjee14&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
