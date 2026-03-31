/**
 * Persistent state for the self-improving flywheel agent.
 * Loaded at startup, saved after every run cycle.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STATE_DIR = join(homedir(), ".suwappu-flywheel");
const STATE_FILE = join(STATE_DIR, "state.json");

export interface TradeRecord {
  id: string;
  timestamp: string;
  strategy: "dca" | "arb" | "yield";
  token: string;
  chain: string;
  amountIn: number;
  amountOut: number;
  priceAtEntry: number;
  fearIndex: number;
  dayOfWeek: string;
  // Backfilled later:
  priceAfter1h?: number;
  priceAfter24h?: number;
  reward?: number;
  profitable?: boolean;
}

export interface VaultBelief {
  alpha: number; // successes + 1
  beta: number;  // failures + 1
}

export interface FlywheelState {
  version: 1;
  lastRun: string;
  trades: TradeRecord[];
  beliefs: {
    vaults: Record<string, VaultBelief>;
    fearMultiplierEff: number;
    arbHitRate7d: number;
  };
  adjustments: {
    dcaAmountMultiplier: number;
    minArbSpread: number;
    maxDrawdownPause: number;
    yieldRotationEnabled: boolean;
  };
  portfolio: {
    totalInvested: number;
    peakValue: number;
    currentValue: number;
    rollingReturns30d: number[];
  };
}

export function defaultState(): FlywheelState {
  return {
    version: 1,
    lastRun: new Date().toISOString(),
    trades: [],
    beliefs: {
      vaults: {},
      fearMultiplierEff: 1.0,
      arbHitRate7d: 0,
    },
    adjustments: {
      dcaAmountMultiplier: 1.0,
      minArbSpread: 0.5,
      maxDrawdownPause: 0.25, // pause at 25% drawdown
      yieldRotationEnabled: true,
    },
    portfolio: {
      totalInvested: 0,
      peakValue: 0,
      currentValue: 0,
      rollingReturns30d: [],
    },
  };
}

export function loadState(): FlywheelState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return defaultState();
}

export function saveState(state: FlywheelState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function recordTrade(
  state: FlywheelState,
  trade: Omit<TradeRecord, "id" | "dayOfWeek">
): TradeRecord {
  const record: TradeRecord = {
    ...trade,
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    dayOfWeek: new Date().toLocaleDateString("en-US", { weekday: "long" }),
  };
  state.trades.push(record);

  // Update portfolio tracking
  state.portfolio.totalInvested += trade.amountIn;
  const returnPct = (trade.amountOut * trade.priceAtEntry - trade.amountIn) / trade.amountIn;
  state.portfolio.rollingReturns30d.push(returnPct);
  if (state.portfolio.rollingReturns30d.length > 30) {
    state.portfolio.rollingReturns30d.shift();
  }

  return record;
}
