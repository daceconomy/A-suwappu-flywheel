#!/usr/bin/env bun
import { Command } from "commander";
import { createClient } from "@suwappu/sdk";
import { requireEnv, log } from "./utils.js";
import { scanYield } from "./strategies/yield.js";
import { executeDCA, getFearIndex, fearMultiplier } from "./strategies/dca.js";
import { scanArb } from "./strategies/arb.js";
import { scanPredictions } from "./strategies/predict.js";
import { loadState, saveState, recordTrade } from "./brain/state.js";
import { backfillRewards } from "./brain/reward.js";
import { adaptParameters, logAgentState } from "./brain/adapt.js";

function getClient() {
  return createClient({ apiKey: requireEnv("SUWAPPU_API_KEY") });
}

const program = new Command()
  .name("suwappu-flywheel")
  .description("Self-sustaining multi-strategy DeFi agent — $50 minimum, $0 API cost")
  .version("1.0.0");

// ── Yield ──
program.command("yield").description("Scan lending markets for best APY")
  .option("--chain <id>", "chain ID", parseInt, 8453)
  .option("--top <n>", "show top N markets", parseInt, 10)
  .option("--min-apy <n>", "minimum APY filter", parseFloat, 0)
  .option("--json", "JSON output")
  .action(async (opts) => {
    try { await scanYield(getClient(), opts); }
    catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── DCA ──
program.command("dca").description("Execute a DCA buy (or dry-run)")
  .option("--token <symbol>", "token to buy", "ETH")
  .option("--amount <n>", "USDC amount", "5")
  .option("--chain <chain>", "chain to trade on", "base")
  .option("--fear-adjust", "multiply amount by Fear & Greed Index factor")
  .option("--execute", "execute the trade (default: dry-run only)")
  .option("--json", "JSON output")
  .action(async (opts) => {
    try {
      const client = getClient();
      const dryRun = !opts.execute;
      let amount = opts.amount;

      if (opts.fearAdjust) {
        const fear = await getFearIndex();
        const mult = fearMultiplier(fear.value);
        amount = String(Math.round(parseFloat(amount) * mult));
        if (!opts.json) {
          log("dca", `Fear Index: ${fear.value}/100 (${fear.classification}) → ${mult}x multiplier → ${amount} USDC`);
        }
      }

      await executeDCA(client, { ...opts, amount, dryRun });
    } catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── Arb ──
program.command("arb").description("Scan for cross-chain price opportunities")
  .option("--tokens <list>", "comma-separated tokens", (v) => v.split(","), ["ETH"])
  .option("--chains <list>", "comma-separated chains", (v) => v.split(","), ["base", "arbitrum", "optimism"])
  .option("--min-spread <pct>", "minimum spread %", parseFloat, 0.1)
  .option("--json", "JSON output")
  .action(async (opts) => {
    try { await scanArb(getClient(), opts); }
    catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── Predict ──
program.command("predict").description("Scout prediction markets for mispricing")
  .option("--top <n>", "number of markets", parseInt, 10)
  .option("--json", "JSON output")
  .action(async (opts) => {
    try { await scanPredictions(getClient(), opts); }
    catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── Status ──
program.command("status").description("Portfolio dashboard")
  .option("--json", "JSON output")
  .action(async (opts) => {
    try {
      const client = getClient();
      const wallet = process.env.WALLET_ADDRESS;
      const chains = await client.listChains();
      log("status", `Connected — ${chains.length} chains available`);

      // Price check (direct API call to avoid npm SDK ?token= bug)
      const apiKey = requireEnv("SUWAPPU_API_KEY");
      const priceRes = await fetch("https://api.suwappu.bot/v1/agent/prices?symbols=ETH,BTC,SOL", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const priceData = await priceRes.json() as { prices: Record<string, { usd: number; change_24h: number }> };
      console.log();
      for (const [token, data] of Object.entries(priceData.prices)) {
        const change = data.change_24h ?? 0;
        console.log(`  ${token.padEnd(5)} $${data.usd.toLocaleString()} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%)`);
      }

      // Fear index
      const fear = await getFearIndex();
      console.log();
      log("status", `Fear & Greed: ${fear.value}/100 (${fear.classification})`);
      log("status", `DCA multiplier: ${fearMultiplier(fear.value)}x`);

      if (wallet) {
        console.log();
        log("status", `Wallet: ${wallet.slice(0, 6)}...${wallet.slice(-4)}`);
      }
    } catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── Watch (continuous monitoring) ──
program.command("watch").description("Continuously scan for opportunities")
  .option("--interval <secs>", "scan interval in seconds", parseInt, 300)
  .option("--tokens <list>", "arb tokens", (v: string) => v.split(","), ["ETH", "SOL"])
  .option("--chains <list>", "arb chains", (v: string) => v.split(","), ["base", "arbitrum", "optimism", "ethereum"])
  .option("--min-spread <pct>", "min arb spread %", parseFloat, 0.3)
  .option("--json", "JSON output")
  .action(async (opts) => {
    const client = getClient();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let round = 0;

    process.on("SIGINT", () => { log("watch", `Stopped after ${round} rounds.`); process.exit(0); });
    process.on("SIGTERM", () => { log("watch", `Stopped after ${round} rounds.`); process.exit(0); });

    if (!opts.json) {
      log("watch", `Continuous monitoring every ${opts.interval}s. Ctrl+C to stop.`);
      log("watch", `Arb: ${opts.tokens.join(",")} across ${opts.chains.join(",")}`);
      console.log();
    }

    while (true) {
      round++;
      try {
        if (!opts.json) log("watch", `── Round ${round} ──`);

        // Fear index
        const fear = await getFearIndex();
        if (!opts.json) log("watch", `Fear: ${fear.value}/100 (${fear.classification}) | DCA mult: ${fearMultiplier(fear.value)}x`);

        // Arb scan
        const opps = await scanArb(client, {
          tokens: opts.tokens,
          chains: opts.chains,
          minSpread: opts.minSpread,
          json: opts.json,
        });

        const viable = opps.filter((o) => o.viable);
        if (viable.length > 0 && !opts.json) {
          log("watch", `🚨 ${viable.length} PROFITABLE arb opportunity(ies) found!`);
        }

        if (!opts.json) console.log();
      } catch (e: any) {
        if (!opts.json) log("watch", `Error: ${e.message}`);
      }

      await sleep(opts.interval * 1000);
    }
  });

// ── Run All (V2 — Self-Improving) ──
program.command("run").description("Run all strategies with self-improving brain")
  .option("--execute", "execute DCA trades (default: scan only)")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const client = getClient();
    const dryRun = !opts.execute;

    // 0. Load persistent brain state
    const state = loadState();

    if (!opts.json) {
      console.log("╔══════════════════════════════════════════╗");
      console.log("║    SUWAPPU FLYWHEEL V2 — SELF-IMPROVING ║");
      console.log("╚══════════════════════════════════════════╝");
      if (dryRun) console.log("  Mode: SCAN ONLY (add --execute to trade)\n");
      else console.log("  Mode: LIVE EXECUTION\n");
    }

    try {
      // 1. Backfill rewards for previous trades
      const apiKey = requireEnv("SUWAPPU_API_KEY");
      const getPrice = async (token: string) => {
        const res = await fetch(`https://api.suwappu.bot/v1/agent/prices?symbols=${token}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const data = await res.json() as { prices?: Record<string, { usd: number }> };
        return data.prices?.[token]?.usd ?? 0;
      };
      const scored = await backfillRewards(state, getPrice);
      if (scored > 0 && !opts.json) log("brain", `Scored ${scored} previous trade(s)`);

      // 2. Adapt parameters based on trade history
      const adaptation = adaptParameters(state);
      if (!opts.json && state.trades.length >= 3) {
        log("brain", `Adaptation: ${adaptation.reason}`);
        logAgentState(state);
      }

      // 3. Observe market
      const fear = await getFearIndex();
      if (!opts.json) log("run", `Fear & Greed: ${fear.value}/100 (${fear.classification})`);

      // 4. Yield scan
      if (!opts.json) console.log("\n── YIELD ROTATION ──");
      await scanYield(client, { chain: 8453, top: 5, json: opts.json });

      // 5. DCA with adaptive sizing
      if (!opts.json) console.log("\n── DCA (ADAPTIVE) ──");
      const fearMult = fearMultiplier(fear.value);
      const brainMult = state.adjustments.dcaAmountMultiplier;
      const effectiveAmount = Math.round(5 * fearMult * brainMult);

      if (brainMult === 0) {
        if (!opts.json) log("dca", "⚠️  DCA PAUSED by drawdown circuit breaker");
      } else {
        if (!opts.json) log("dca", `Fear: ${fearMult}x | Brain: ${brainMult.toFixed(2)}x | Amount: ${effectiveAmount} USDC`);
        const dcaResult = await executeDCA(client, {
          token: "ETH",
          amount: String(effectiveAmount),
          chain: "base",
          dryRun,
          json: opts.json,
        });

        // Record trade in brain state
        if (dcaResult.executed || dryRun) {
          const price = dcaResult.price;
          recordTrade(state, {
            timestamp: new Date().toISOString(),
            strategy: "dca",
            token: "ETH",
            chain: "base",
            amountIn: effectiveAmount,
            amountOut: parseFloat(dcaResult.toAmount || "0"),
            priceAtEntry: price,
            fearIndex: fear.value,
          });
        }
      }

      // 6. Arb scan with adaptive threshold
      if (!opts.json) console.log("\n── ARB SCANNER (ADAPTIVE) ──");
      const minSpread = state.adjustments.minArbSpread;
      if (!opts.json) log("arb", `Learned min spread: ${minSpread.toFixed(2)}%`);
      await scanArb(client, {
        tokens: ["ETH", "SOL"],
        chains: ["base", "arbitrum", "optimism", "ethereum"],
        minSpread,
        json: opts.json,
      });

      // 7. Prediction scout
      if (!opts.json) console.log("\n── PREDICTION SCOUT ──");
      await scanPredictions(client, { top: 5, json: opts.json });

      // 8. Save brain state
      saveState(state);

      if (!opts.json) {
        console.log("\n── BRAIN STATUS ──");
        log("brain", `Trades recorded: ${state.trades.length}`);
        log("brain", `DCA multiplier: ${state.adjustments.dcaAmountMultiplier.toFixed(2)}x`);
        log("brain", `Arb threshold: ${state.adjustments.minArbSpread.toFixed(2)}%`);
        log("brain", `State saved to ~/.suwappu-flywheel/state.json`);
        if (dryRun) log("run", "Add --execute to enable DCA trades.");
      }
    } catch (e: any) {
      // Save state even on error
      saveState(state);
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

program.parseAsync();
