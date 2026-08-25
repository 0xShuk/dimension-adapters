import ADDRESSES from "../../helpers/coreAssets.json";
import { Dependencies, FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { queryAllium } from "../../helpers/allium";

// On Ride Markets, the callers choose coin, duration, direction (up/down) and place a trade from treasury. 
// Each trade is executed through our Trade Executor program. Fees are charged when a
// trade settles: `execute_intent` ix for spot and `perp_finalize` ix for Phoenix perps.
const RIDE_PROGRAM = "tRADeQ3SJVHnFXv1rpwZzVt5HE6DWDu4J6cH34Md6ZA";

// Protocol fee wallet, in USDC only - in addition to the swap and profit fees, it also receives the flat
// intent-opening fee, which the app sends as a plain transfer rather than through the program.
// https://solscan.io/account/ejBYopijneorWAQ1rN6FiZMvmfXbcjcz4mELCNMRsPW
const FEE_TAKER = "ejBYopijneorWAQ1rN6FiZMvmfXbcjcz4mELCNMRsPW";

// On-chain fee schedule. All fees are charged in USDC.
const SWAP_FEE_BPS = 70; // 0.7% of the treasury's gross USDC return
const NORMAL_CLOSE_FEE_BPS = 100; // 1% of the caller's gross profit share
const EARLY_CLOSE_FEE_BPS = 1000; // 10% instead, when the close lands inside the early window
// const INTENT_OPENING_FEE = 0.1/1; // The fourth avenue of fees is the intent-opening fees 
// which is a plain SPL transfer of either 0.1 USDC or 1 USDC depending on the number of trades placed 
// in a single ride

// Ratio of the caller's net payout to the profit fee, for each close type:
// payout = gross - fee = fee * (10000 - bps) / bps.
const PAYOUT_RATIOS: [boolean, number][] = [
  [true, (10000 - EARLY_CLOSE_FEE_BPS) / EARLY_CLOSE_FEE_BPS], // 9x
  [false, (10000 - NORMAL_CLOSE_FEE_BPS) / NORMAL_CLOSE_FEE_BPS], // 99x
];

// Tolerance on the payout ratio, to absorb the program's integer division.
const RATIO_TOLERANCE = 0.005;

type Payout = { recipient: string; amount: number };
type Split = { swap: number; profit: number; early: boolean; caller: number };

// The treasury's net receipt pins the swap fee exactly: the program pays out
// `gross - floor(gross * 70 / 10000)`, so the gross can be recovered from the net.
const grossFromNet = (net: number): number => {
  const approx = Math.round(net / (1 - SWAP_FEE_BPS / 10000));
  for (const gross of [approx - 2, approx - 1, approx, approx + 1, approx + 2]) {
    if (gross - Math.floor((gross * SWAP_FEE_BPS) / 10000) === net) return gross;
  }
  return approx;
};

// A settlement sends USDC out of the intent vault to the treasury, to the fee wallet, and - when
// the trade closed with profits - to the caller. The fee wallet's transfer is the swap fee
// and the profit fee combined.
//
// The caller's payout must then be exactly 9x (early close) or 99x (normal close) that profit fee.
const splitFees = (feeTotal: number, payouts: Payout[]): Split | null => {
  if (feeTotal <= 0 || !payouts.length) return null;
  // A settlement that closed with no profits pays only the treasury, so the whole fee is the
  // swap fee.
  if (payouts.length === 1) {
    const derived = grossFromNet(payouts[0].amount) - payouts[0].amount;
    return Math.abs(derived - feeTotal) <= 2 ? { swap: feeTotal, profit: 0, early: false, caller: 0 } : null;
  }

  let best: (Split & { error: number }) | null = null;
  payouts.forEach((candidate, i) => {
    const swap = grossFromNet(candidate.amount) - candidate.amount;
    const profit = feeTotal - swap;
    if (profit < 0) return;
    const rest = payouts.reduce((sum, p, j) => (j === i ? sum : sum + p.amount), 0);
    if (profit === 0) {
      if (rest === 0 && !best) best = { error: 0, swap, profit: 0, early: false, caller: 0 };
      return;
    }
    for (const [early, ratio] of PAYOUT_RATIOS) {
      const error = Math.abs(rest - profit * ratio) / Math.max(rest, 1);
      if (error <= RATIO_TOLERANCE && (!best || error < best.error)) {
        best = { error, swap, profit, early, caller: rest };
      }
    }
  });
  return best;
};

const fetch = async (options: FetchOptions) => {
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();
  const timeRange = `block_timestamp >= TO_TIMESTAMP_NTZ(${options.startTimestamp})
        AND block_timestamp < TO_TIMESTAMP_NTZ(${options.endTimestamp})`;

  const query = `
    WITH fee_legs AS (
      SELECT txn_id, from_address AS vault, SUM(raw_amount) AS fee_total
      FROM solana.assets.transfers
      WHERE outer_program_id = '${RIDE_PROGRAM}'
        AND to_address = '${FEE_TAKER}'
        AND mint = '${ADDRESSES.solana.USDC}'
        AND ${timeRange}
      GROUP BY txn_id, from_address
    ),
    payouts AS (
      SELECT txn_id, from_address AS vault, to_address AS recipient, SUM(raw_amount) AS amount
      FROM solana.assets.transfers
      WHERE outer_program_id = '${RIDE_PROGRAM}'
        AND to_address != '${FEE_TAKER}'
        AND mint = '${ADDRESSES.solana.USDC}'
        AND ${timeRange}
      GROUP BY txn_id, from_address, to_address
    )
    SELECT
      f.txn_id AS txn_id,
      f.vault AS vault,
      f.fee_total AS fee_total,
      p.recipient AS recipient,
      p.amount AS amount
    FROM fee_legs f
    LEFT JOIN payouts p
      ON p.txn_id = f.txn_id AND p.vault = f.vault
  `;

  const inflowQuery = `
    SELECT SUM(raw_amount) AS amount
    FROM solana.assets.transfers
    WHERE to_address = '${FEE_TAKER}'
      AND from_address != '${FEE_TAKER}'
      AND mint = '${ADDRESSES.solana.USDC}'
      AND ${timeRange}
  `;

  const rows = await queryAllium(query);
  const inflow = await queryAllium(inflowQuery);

  const settlements = new Map<string, { feeTotal: number; payouts: Payout[] }>();
  rows.forEach((row: any) => {
    const key = `${row.txn_id}:${row.vault}`;
    if (!settlements.has(key)) settlements.set(key, { feeTotal: Number(row.fee_total), payouts: [] });
    if (row.recipient) settlements.get(key)!.payouts.push({ recipient: row.recipient, amount: Number(row.amount) });
  });

  const usdc = ADDRESSES.solana.USDC;
  let settlementFees = 0;
  settlements.forEach(({ feeTotal, payouts }) => {
    settlementFees += feeTotal;
    const split = splitFees(feeTotal, payouts);
    if (!split) {
      // In case the split doesn't resolve, for old intents transactions
      dailyFees.add(usdc, feeTotal, "Unsplit Settlement Fees");
      dailyRevenue.add(usdc, feeTotal, "Unsplit Settlement Fees To Protocol");
      return;
    }
    const profitLabel = split.early ? "Early Close Fees" : "Profit Share Fees";
    dailyFees.add(usdc, split.swap, "Swap Fees");
    dailyRevenue.add(usdc, split.swap, "Swap Fees To Protocol");
    if (split.profit > 0) {
      dailyFees.add(usdc, split.profit, profitLabel);
      dailyRevenue.add(usdc, split.profit, `${profitLabel} To Protocol`);
    }
    if (split.caller > 0) {
      dailyFees.add(usdc, split.caller, "Caller Profit Share");
      dailySupplySideRevenue.add(usdc, split.caller, "Caller Profit Share To Bet Creator");
    }
  });

  const creationFees = Number(inflow[0]?.amount ?? 0) - settlementFees;
  if (creationFees > 0) {
    dailyFees.add(usdc, creationFees, "Intent Creation Fees");
    dailyRevenue.add(usdc, creationFees, "Intent Creation Fees To Protocol");
  }

  return {
    dailyFees,
    dailyUserFees: dailyFees,
    dailyRevenue,
    dailyProtocolRevenue: dailyRevenue,
    dailySupplySideRevenue,
  };
};

const methodology = {
  Fees: "Everything paid to trade through Ride: a flat fee to open an intent, a swap fee on treasury deployment and a fee on the closing caller's profit share",
  UserFees: "Same as Fees - charged to the funds (treasuries) being traded for, or to the user opening the intent.",
  Revenue: "The intent-opening fee, the swap fee and the profit-share fee, all of which are paid to the Ride fee wallet.",
  ProtocolRevenue: "Same as Revenue - the fee wallet is a protocol-controlled account.",
  SupplySideRevenue: "The caller's profit share, paid out of the treasury's realised profit to the creator of the trade.",
};

const breakdownMethodology = {
  Fees: {
    "Intent Creation Fees": "Flat fee charged when an intent is opened (0.1 or 1 USDC in observed activity). The app sends it as a plain USDC transfer to the fee wallet in the same transaction as `create_intent`, which sowell-gov invokes by CPI, so it carries no Ride outer instruction. Measured as the fee wallet's USDC receipts that are not accounted for by a settlement.",
    "Swap Fees": "0.7% of the gross USDC returned to the treasury on a settlement. Charged only on the USDC-return leg, so opening a position is free.",
    "Profit Share Fees": "1% of the closing caller's gross profit share, on a normal close.",
    "Early Close Fees": "10% of the closing caller's gross profit share, charged instead of the 1% when the position is closed inside the early-close window.",
    "Caller Profit Share": "The caller's own cut of realised profit, net of the fee above. Set per DAO by `caller_payout_bps` in the realm's Sowellian config and paid straight to the bet creator.",
    "Unsplit Settlement Fees": "Fee-wallet receipts from settlements whose split could not be resolved. Kept so the reported total always equals what the fee wallet received; expected to be zero.",
  },
  UserFees: {
    "Intent Creation Fees": "Same as Fees.",
    "Swap Fees": "Same as Fees.",
    "Profit Share Fees": "Same as Fees.",
    "Early Close Fees": "Same as Fees.",
    "Caller Profit Share": "Same as Fees.",
    "Unsplit Settlement Fees": "Same as Fees.",
  },
  Revenue: {
    "Intent Creation Fees To Protocol": "The full intent-opening fee; it is paid to the Ride fee wallet.",
    "Swap Fees To Protocol": "The full 0.7% swap fee; it is paid to the Ride fee wallet.",
    "Profit Share Fees To Protocol": "The full 1% normal-close profit fee; it is paid to the Ride fee wallet.",
    "Early Close Fees To Protocol": "The full 10% early-close profit fee; it is paid to the Ride fee wallet.",
    "Unsplit Settlement Fees To Protocol": "As above - reached the fee wallet but could not be attributed to a fee type.",
  },
  ProtocolRevenue: {
    "Intent Creation Fees To Protocol": "Same as Revenue.",
    "Swap Fees To Protocol": "Same as Revenue.",
    "Profit Share Fees To Protocol": "Same as Revenue.",
    "Early Close Fees To Protocol": "Same as Revenue.",
    "Unsplit Settlement Fees To Protocol": "Same as Revenue.",
  },
  SupplySideRevenue: {
    "Caller Profit Share To Bet Creator": "Profit share paid to the creator of the closed bet. It never reaches the protocol, so it is a cost of revenue rather than revenue.",
  },
};

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  fetch,
  start: "2026-06-11",
  chains: [CHAIN.SOLANA],
  dependencies: [Dependencies.ALLIUM],
  isExpensiveAdapter: true,
  methodology,
  breakdownMethodology,
};

export default adapter;
