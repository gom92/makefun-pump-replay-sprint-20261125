// Dawn Dip Reversion — a dip-reversion paper-trading bot for pump.fun bonding curves.
//
// Idea: a coin that ran up hard off launch, then gave back a quarter or more of its
// peak, and whose tape has just turned net-buyer again, is often a bounce, not a
// burial. This bot buys that dip once per cycle and exits on a bounce, a cut, a
// trailing stop, a hold cap, or silence. It never chases a fresh launch, never buys
// a coin still making new lows, and never buys the same dip twice: after an exit a
// coin must print a new peak at least 10% above the old one before it can qualify
// again.
//
// Everything is a pure function of the batches the harness feeds it: no clock, no
// randomness, no I/O, no floats — prices are kept as bigint fractions so two runs
// over the same window produce byte-identical action logs.

import { type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface DipConfig {
  /** Lamports to spend on one dip buy (capped by 1% of the curve's real SOL). */
  stakeLamports: bigint;
  /** Smallest real-SOL reserve a coin must hold to be tradable. */
  minRealSolLamports: bigint;
  /** Smallest trade count before a coin can qualify. */
  minTrades: number;
  /** Youngest / oldest age (slots since CreateEvent) at which a dip may be bought. */
  minAgeSlots: number;
  maxAgeSlots: number;
  /** Peak must sit at least this far (bps) above the launch price. */
  minRunupBps: number;
  /** Current price must sit at least this far (bps) below the peak. */
  minDipBps: number;
  /** Current price must still sit at least this far (bps) above the launch price. */
  minHoldAboveLaunchBps: number;
  /** The peak must have been printed within this many slots. */
  peakFreshSlots: number;
  /** Net buy flow is measured over this many slots. */
  flowWindowSlots: number;
  /** Stabilisation window (slots) and the most the price may have fallen over it (bps). */
  stabWindowSlots: number;
  stabMaxDropBps: number;
  /** Take-profit / stop-loss on position value vs cost (bps). */
  tpBps: number;
  slBps: number;
  /** Trailing stop: once up trailArmBps, exit on a trailDropBps fall from the best value. */
  trailArmBps: number;
  trailDropBps: number;
  /** Exit after holding this many slots, or after this many slots without a trade. */
  maxHoldSlots: number;
  staleSlots: number;
  /** Slippage tolerance on buys / sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Max open positions (mirrors the harness cap). */
  maxOpen: number;
}

export const DEFAULT_CONFIG: DipConfig = {
  stakeLamports: 150_000_000n,
  minRealSolLamports: 500_000_000n,
  minTrades: 8,
  minAgeSlots: 10,
  maxAgeSlots: 6000,
  minRunupBps: 8000,
  minDipBps: 2500,
  minHoldAboveLaunchBps: 2000,
  peakFreshSlots: 1500,
  flowWindowSlots: 60,
  stabWindowSlots: 30,
  stabMaxDropBps: 100,
  tpBps: 3500,
  slBps: 1500,
  trailArmBps: 1800,
  trailDropBps: 1000,
  maxHoldSlots: 400,
  staleSlots: 80,
  buySlippageBps: 10_000,
  sellSlippageBps: 10_000,
  maxOpen: 5,
};

/** A price as a fraction: virtual quote reserves over virtual token reserves. */
interface Price {
  n: bigint;
  d: bigint;
}

function priceOf(vq: bigint, vt: bigint): Price {
  return { n: vq, d: vt > 0n ? vt : 1n };
}

/** (to - from) / from in bps, truncated toward zero. Pure bigint math. */
function bpsChange(from: Price, to: Price): number {
  const num = (to.n * from.d - from.n * to.d) * 10_000n;
  const den = from.n * to.d;
  if (den === 0n) return 0;
  return Number(num / den);
}

function priceGte(a: Price, b: Price): boolean {
  return a.n * b.d >= b.n * a.d;
}

interface FlowTick {
  slot: number;
  /** +quote lamports on a buy, -quote lamports on a sell. */
  signed: bigint;
}

interface Tape {
  mint: Pubkey;
  createdSlot: number;
  launch: Price;
  peak: Price;
  peakSlot: number;
  last: Price;
  lastTradeSlot: number;
  trades: number;
  complete: boolean;
  flow: FlowTick[];
  hist: { slot: number; price: Price }[];
  /** Peak at the moment of the last exit; re-entry needs a new peak 10% above it. */
  lastExitPeak: Price | null;
}

interface OpenTrade {
  entrySlot: number;
  /** Best position value vs cost seen so far (bps). */
  peakBps: number;
}

export function createBot(config: DipConfig = DEFAULT_CONFIG): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const book = new Map<Pubkey, OpenTrade>();
  const sentBuySlot = new Map<Pubkey, number>();

  function tapeFor(mint: Pubkey): Tape | undefined {
    return tapes.get(mint);
  }

  function noteTrade(t: Tape, slot: number, price: Price, isBuy: boolean, quote: bigint): void {
    t.last = price;
    t.lastTradeSlot = slot;
    t.trades += 1;
    if (priceGte(price, t.peak)) {
      t.peak = price;
      t.peakSlot = slot;
    }
    t.flow.push({ slot, signed: isBuy ? quote : -quote });
    const horizon = slot - config.flowWindowSlots;
    while (t.flow.length > 0 && t.flow[0]!.slot <= horizon) t.flow.shift();
    const lastSample = t.hist[t.hist.length - 1];
    if (lastSample === undefined || lastSample.slot < slot) {
      t.hist.push({ slot, price });
      if (t.hist.length > 96) t.hist.shift();
    }
  }

  function netFlow(t: Tape, slot: number): bigint {
    const horizon = slot - config.flowWindowSlots;
    let net = 0n;
    for (const tick of t.flow) if (tick.slot > horizon) net += tick.signed;
    return net;
  }

  /** Price at least stabWindowSlots ago, or null when the coin is too young. */
  function oldPrice(t: Tape, slot: number): Price | null {
    const horizon = slot - config.stabWindowSlots;
    let found: Price | null = null;
    for (const s of t.hist) {
      if (s.slot <= horizon) found = s.price;
      else break;
    }
    return found;
  }

  function qualifies(state: BotState, t: Tape, slot: number): boolean {
    const curve = state.curves.get(t.mint);
    if (curve === undefined || curve.complete || t.complete) return false;
    if (state.positions.has(t.mint)) return false;
    if (sentBuySlot.has(t.mint)) return false;
    const age = slot - t.createdSlot;
    if (age < config.minAgeSlots || age > config.maxAgeSlots) return false;
    if (t.trades < config.minTrades) return false;
    if (curve.real_quote_reserves < config.minRealSolLamports) return false;
    if (bpsChange(t.launch, t.peak) < config.minRunupBps) return false;
    if (bpsChange(t.peak, t.last) > -config.minDipBps) return false;
    if (bpsChange(t.launch, t.last) < config.minHoldAboveLaunchBps) return false;
    if (slot - t.peakSlot > config.peakFreshSlots) return false;
    if (t.lastExitPeak !== null && bpsChange(t.lastExitPeak, t.peak) < 1000) return false;
    const old = oldPrice(t, slot);
    if (old === null) return false;
    if (bpsChange(old, t.last) < -config.stabMaxDropBps) return false;
    if (netFlow(t, slot) <= 0n) return false;
    return true;
  }

  function positionValue(state: BotState, mint: Pubkey, tokens: bigint): bigint | null {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return null;
    if (curve.virtual_token_reserves <= 0n) return null;
    return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = state.slot;
      const orders: OrderInput[] = [];

      // 1. Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!tapes.has(e.mint)) {
            const launch = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
            tapes.set(e.mint, {
              mint: e.mint,
              createdSlot: e.slot,
              launch,
              peak: launch,
              peakSlot: e.slot,
              last: launch,
              lastTradeSlot: e.slot,
              trades: 0,
              complete: false,
              flow: [],
              hist: [{ slot: e.slot, price: launch }],
              lastExitPeak: null,
            });
          }
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          if (t === undefined) continue;
          const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          noteTrade(t, e.slot, price, e.is_buy, BigInt(e.quote_amount));
        } else if (e.event === 'CompleteEvent') {
          const t = tapeFor(e.mint);
          if (t !== undefined) t.complete = true;
        }
      }

      // 2. Drop book entries whose positions are gone; remember the peak at exit.
      for (const mint of [...book.keys()]) {
        if (!state.positions.has(mint)) {
          const t = tapeFor(mint);
          if (t !== undefined) t.lastExitPeak = t.peak;
          book.delete(mint);
        }
      }
      // A buy that never filled leaves no position and no pending order: forget it.
      for (const mint of [...sentBuySlot.keys()]) {
        if (state.positions.has(mint)) continue;
        let pendingBuy = false;
        for (const p of state.pending.values()) {
          if (p.order.mint === mint && p.order.side === 'buy') {
            pendingBuy = true;
            break;
          }
        }
        if (!pendingBuy) sentBuySlot.delete(mint);
      }

      // 3. Exits, in mint order so the reply is deterministic.
      for (const mint of [...state.positions.keys()].sort()) {
        const holding = state.positions.get(mint)!;
        const value = positionValue(state, mint, holding.token_amount);
        if (value === null) continue;
        const trade = book.get(mint) ?? { entrySlot: slot, peakBps: 0 };
        const pnlBps = Number(((value - holding.cost_lamports) * 10_000n) / holding.cost_lamports);
        if (pnlBps > trade.peakBps) trade.peakBps = pnlBps;
        book.set(mint, trade);
        const t = tapeFor(mint);
        const lastTrade = t !== undefined ? t.lastTradeSlot : slot;
        let exit = false;
        if (pnlBps >= config.tpBps) exit = true;
        else if (pnlBps <= -config.slBps) exit = true;
        else if (trade.peakBps >= config.trailArmBps && pnlBps <= trade.peakBps - config.trailDropBps) exit = true;
        else if (slot - trade.entrySlot >= config.maxHoldSlots) exit = true;
        else if (slot - lastTrade >= config.staleSlots) exit = true;
        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: config.sellSlippageBps });
        }
      }

      // 4. Entries: coins that traded in this batch, in event order.
      if (state.committedPositionCount() < config.maxOpen) {
        const seen = new Set<Pubkey>();
        for (const e of batch.events) {
          if (orders.length >= 16) break;
          if (seen.has(e.mint)) continue;
          seen.add(e.mint);
          const t = tapeFor(e.mint);
          if (t === undefined) continue;
          if (!qualifies(state, t, slot)) continue;
          if (state.committedPositionCount() >= config.maxOpen) break;
          const cap = state.maxBuyLamports(e.mint);
          const stake = config.stakeLamports < cap ? config.stakeLamports : cap;
          if (stake < 10_000_000n) continue;
          if (state.freeCashLamports() < stake + state.txFeeLamports()) continue;
          orders.push({ side: 'buy', mint: e.mint, quote_lamports: stake, max_slippage_bps: config.buySlippageBps });
          sentBuySlot.set(e.mint, slot);
        }
      }

      return orders;
    },
  };
}
