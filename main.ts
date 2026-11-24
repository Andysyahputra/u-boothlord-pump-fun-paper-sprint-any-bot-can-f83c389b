// Pump.fun Paper Sprint — momentum bot (agent-fun/replay/v2, NDJSON, paper only).
// Strategy: buy small (1% of capital) into a FRESH mint showing early buy
// pressure and a modest rise, never chase a vertical spike; take profit +25%,
// cut losses -15%, flatten any stale position. No shorts, no leverage.
import * as readline from "node:readline";

type Order =
  | { side: "buy"; client_id: string; mint: string; quote_lamports: string; max_slippage_bps: number }
  | { side: "sell"; client_id: string; mint: string; token_amount: string; max_slippage_bps: number };

interface MintStat {
  firstPrice: number;
  lastPrice: number;
  firstSlot: number;
  firstBatch: number;
  buySol: bigint;
  sellSol: bigint;
  buyCount: number;
  sellCount: number;
  realSol: bigint;
  seenBatches: number;
}

interface Held {
  mint: string;
  tokens: bigint;
  cost: bigint; // lamports paid
  entryPrice: number; // lamports per token
  boughtBatch: number;
}

const toNum = (s: string | undefined): number => {
  if (!s) return 0;
  try { return Number(BigInt(s)); } catch { return Number(s) || 0; }
};
const priceOf = (solRes: string, tokRes: string): number => {
  const t = toNum(tokRes);
  if (t <= 0) return 0;
  return toNum(solRes) / t; // lamports per token
};

let capital = 10_000_000_000n;
let maxOpen = 5;
let maxOrderBps = 500;
let maxOrdersPerBatch = 5;
let orderSeq = 0;
let batchNo = 0;

const stats = new Map<string, MintStat>();
const held = new Map<string, Held>();
// Positions we bought but whose fill has not arrived yet (avoid double-buy).
const pendingBuy = new Set<string>();

const SIZE_BPS_OF_CAPITAL = 100; // 1% of capital per trade
const MIN_BUY_SOL = 200_000_000n; // 0.2 SOL of buy volume before entry
const MIN_BUY_COUNT = 4;
const MIN_RISE = 0.05; // +5% vs first seen price (stricter: was +3%)
const MAX_RISE = 0.40; // never chase > +40% from first seen
const TAKE_PROFIT = 0.20; // bank sooner (was +25%)
const STOP_LOSS = 0.10; // tighter cut (was -15%)
const MAX_HOLD_BATCHES = 40;
const MAX_ENTRY_AGE_BATCHES = 20;
const SLIPPAGE_BPS = 500;

function handleBatch(msg: any): Order[] {
  batchNo++;
  const orders: Order[] = [];
  const push = (o: Order) => { if (orders.length < maxOrdersPerBatch) orders.push(o); };

  // 1) Sync positions from the harness account snapshot (authoritative).
  const positions = new Map<string, { tokens: bigint; cost: bigint }>();
  if (msg.account?.positions) {
    for (const p of msg.account.positions) {
      positions.set(p.mint, { tokens: BigInt(p.token_amount), cost: BigInt(p.cost_lamports) });
    }
  }
  // Drop held entries that are gone, refresh entry price from snapshot.
  for (const [mint, h] of [...held.entries()]) {
    const p = positions.get(mint);
    if (!p || p.tokens === 0n) held.delete(mint);
    else {
      h.tokens = p.tokens; h.cost = p.cost;
      h.entryPrice = p.cost > 0n && p.tokens > 0n ? Number(p.cost) / Number(p.tokens) : h.entryPrice;
    }
  }
  for (const [mint, p] of positions) {
    if (!held.has(mint) && p.tokens > 0n) {
      held.set(mint, {
        mint, tokens: p.tokens, cost: p.cost,
        entryPrice: Number(p.cost) / Number(p.tokens), boughtBatch: batchNo,
      });
    }
  }
  // Fills: a buy fill clears the pending flag.
  if (Array.isArray(msg.fills)) {
    for (const f of msg.fills) {
      if (f.side === "buy" && f.status === "filled") pendingBuy.delete(f.mint);
      if (f.side === "sell" && f.status === "filled") pendingBuy.delete(f.mint);
    }
  }

  // 2) Update per-mint stats from events + marks (marks are the price truth).
  const markPrice = new Map<string, number>();
  if (Array.isArray(msg.marks)) {
    for (const m of msg.marks) {
      const p = priceOf(m.virtual_quote_reserves, m.virtual_token_reserves);
      if (p > 0) markPrice.set(m.mint, p);
    }
  }
  if (Array.isArray(msg.events)) {
    for (const ev of msg.events) {
      if (ev.event === "CreateEvent") {
        if (!stats.has(ev.mint)) {
          const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
          stats.set(ev.mint, {
            firstPrice: p > 0 ? p : 0, lastPrice: p, firstSlot: ev.slot ?? msg.slot,
            firstBatch: batchNo, buySol: 0n, sellSol: 0n, buyCount: 0, sellCount: 0,
            realSol: 0n, seenBatches: 1,
          });
        }
        continue;
      }
      if (ev.event !== "TradeEvent") continue;
      let st = stats.get(ev.mint);
      const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
      if (!st) {
        st = {
          firstPrice: p, lastPrice: p, firstSlot: ev.slot ?? msg.slot, firstBatch: batchNo,
          buySol: 0n, sellSol: 0n, buyCount: 0, sellCount: 0, realSol: 0n, seenBatches: 1,
        };
        stats.set(ev.mint, st);
      }
      if (p > 0) st.lastPrice = p;
      if (ev.real_sol_reserves) st.realSol = BigInt(ev.real_sol_reserves);
      const amt = BigInt(ev.sol_amount || "0");
      if (ev.is_buy) { st.buySol += amt; st.buyCount++; }
      else { st.sellSol += amt; st.sellCount++; }
    }
  }
  // Marks refresh last price / real reserve proxy.
  for (const [mint, p] of markPrice) {
    const st = stats.get(mint);
    if (st) { st.lastPrice = p; st.seenBatches++; }
  }

  // 3) Exits first: TP / SL / stale — flatten before the close.
  for (const [mint, h] of [...held.entries()]) {
    const price = markPrice.get(mint) ?? stats.get(mint)?.lastPrice ?? 0;
    if (!price || !h.entryPrice) continue;
    const ret = price / h.entryPrice - 1;
    const stale = batchNo - h.boughtBatch >= MAX_HOLD_BATCHES;
    if (ret >= TAKE_PROFIT || ret <= -STOP_LOSS || stale) {
      push({
        side: "sell", client_id: `sell-${++orderSeq}`, mint,
        token_amount: h.tokens.toString(), max_slippage_bps: SLIPPAGE_BPS,
      });
      held.delete(mint);
    }
  }

  // 4) Entries: fresh mint, real buy pressure, modest rise, not a spike.
  const cash = msg.account?.cash_lamports ? BigInt(msg.account.cash_lamports) : capital;
  const size = (capital * BigInt(SIZE_BPS_OF_CAPITAL)) / 10000n;
  for (const [mint, st] of stats) {
    if (orders.length >= maxOrdersPerBatch) break;
    if (held.has(mint) || pendingBuy.has(mint)) continue;
    if (held.size + pendingBuy.size >= maxOpen) break;
    if (batchNo - st.firstBatch > MAX_ENTRY_AGE_BATCHES) continue;
    if (st.buyCount < MIN_BUY_COUNT) continue;
    if (st.buySol < MIN_BUY_SOL) continue;
    // Buyers must dominate sellers 2:1 (stricter: was 1.5:1).
    if (st.buySol < st.sellSol * 2n) continue;
    if (!st.firstPrice || !st.lastPrice) continue;
    const rise = st.lastPrice / st.firstPrice - 1;
    if (rise < MIN_RISE || rise > MAX_RISE) continue; // no chase
    // Cap by real reserve and by cash.
    let quote = size;
    if (st.realSol > 0n && maxOrderBps > 0) {
      const capByReserve = (st.realSol * BigInt(maxOrderBps)) / 10000n;
      if (capByReserve < quote) quote = capByReserve;
    }
    if (quote > cash) quote = cash;
    if (quote <= 0n) continue;
    pendingBuy.add(mint);
    push({
      side: "buy", client_id: `buy-${++orderSeq}`, mint,
      quote_lamports: quote.toString(), max_slippage_bps: SLIPPAGE_BPS,
    });
  }

  return orders;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: any;
    try { msg = JSON.parse(trimmed); } catch { continue; }
    if (msg.type === "hello") {
      if (msg.capital?.lamports) capital = BigInt(msg.capital.lamports);
      if (msg.caps) {
        maxOpen = msg.caps.max_open_positions ?? maxOpen;
        maxOrderBps = msg.caps.max_order_bps_of_real_reserve ?? maxOrderBps;
        maxOrdersPerBatch = msg.caps.max_orders_per_batch ?? maxOrdersPerBatch;
      }
      continue;
    }
    if (msg.type === "batch") {
      const orders = handleBatch(msg);
      process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
      continue;
    }
    if (msg.type === "done") break;
  }
}

main().catch(() => process.exit(1));
