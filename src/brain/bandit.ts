/**
 * Thompson Sampling for yield vault rotation.
 * Each vault is an "arm" in a multi-armed bandit.
 * The agent samples from Beta distributions and picks the best vault.
 */
import type { VaultBelief } from "./state.js";

/**
 * Sample from a Beta distribution using the Jöhnk algorithm.
 * Simple, no external dependencies.
 */
export function betaSample(alpha: number, beta: number): number {
  // Use gamma sampling method: Beta(a,b) = G(a) / (G(a) + G(b))
  const ga = gammaSample(alpha);
  const gb = gammaSample(beta);
  return ga / (ga + gb);
}

function gammaSample(shape: number): number {
  if (shape < 1) {
    // Ahrens-Dieter method for shape < 1
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  // Marsaglia and Tsang's method for shape >= 1
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = normalSample();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample(): number {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Choose the best vault using Thompson Sampling.
 * Returns the vault name with the highest sampled reward.
 */
export function chooseVault(
  beliefs: Record<string, VaultBelief>
): { vault: string; confidence: number } {
  const entries = Object.entries(beliefs);
  if (entries.length === 0) return { vault: "", confidence: 0 };

  let bestVault = entries[0][0];
  let bestSample = -Infinity;

  for (const [vault, { alpha, beta }] of entries) {
    const sample = betaSample(alpha, beta);
    if (sample > bestSample) {
      bestSample = sample;
      bestVault = vault;
    }
  }

  // Confidence = mean of the best vault's Beta distribution
  const best = beliefs[bestVault];
  const confidence = best.alpha / (best.alpha + best.beta);

  return { vault: bestVault, confidence };
}

/**
 * Update beliefs after observing a vault's yield.
 * "Success" = this vault's APY was above the median of all vaults.
 */
export function updateVaultBelief(
  beliefs: Record<string, VaultBelief>,
  vault: string,
  success: boolean
): void {
  if (!beliefs[vault]) {
    beliefs[vault] = { alpha: 1, beta: 1 }; // Uniform prior
  }
  if (success) {
    beliefs[vault].alpha += 1;
  } else {
    beliefs[vault].beta += 1;
  }
}

/**
 * Initialize beliefs for a set of vaults (uniform prior).
 */
export function initVaultBeliefs(vaultNames: string[]): Record<string, VaultBelief> {
  const beliefs: Record<string, VaultBelief> = {};
  for (const name of vaultNames) {
    beliefs[name] = { alpha: 1, beta: 1 };
  }
  return beliefs;
}
