// The token radar's model (radar-3): one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every other
// rankable pre-token protocol: the early radar the board exists to find. A protocol is pre-token when
// its record carries no token (no market cap, no CoinGecko id, no symbol); the snapshot's live-token
// protocols are kept apart and shown with the market's own values, never mixed into the ranking.
//
// Implied value follows only from the snapshot's own figures, through three factors:
//
//   multiple   the market's own price of a dollar of TVL, per category: the MEDIAN market-cap / TVL
//              of the live protocols in the same category. A category with at least three live
//              comparables uses its median as-is — that median is the market's own number. A thinner
//              category (one or two comparables) does not get its raw median: one observation's ratio
//              can be 400x the market (one live Prediction Market protocol prices at 400x TVL), so its
//              median is first held inside [0.5x, 2x] the global median, then blended with the global
//              median at a prior weight of 8 protocols: multiple = (n x held median + 8 x global) /
//              (n + 8). A category with no live comparables scores at the global median, the median
//              over all live protocols. Every multiple is clamped to [0.05, 2.00].
//   growth     clamp(change_7d, -50, 100) per cent; growthMult = 1 + (growth / 100) x 0.5.
//              The clamp keeps one week's 4,448% print from deciding a protocol's value.
//   maturity   0.7 + 0.3 x min(age_days, 730) / 730; age is days since first listing, the record of
//              how long a protocol has run with no token. Unknown age counts as 180 days.
//   implied    = max(1, round(tvl_usd x multiple x growthMult x maturity))
//
// No protocol name is ever special-cased: the same function scores every row, and the dashboard
// prints the multiple and both multipliers beside every implied value so any row can be checked.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  min_category_comparables: number;
  multiple_shrinkage_prior: number;
  multiple_winsor_low: number;
  multiple_winsor_high: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 730,
  unknown_age_days: 180,
  multiple_floor: 0.05,
  multiple_cap: 2.0,
  min_category_comparables: 3,
  multiple_shrinkage_prior: 8,
  multiple_winsor_low: 0.5,
  multiple_winsor_high: 2.0,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted list of numbers; null when the list is empty. */
function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The market's own price of a dollar of TVL, per category: the median market-cap / TVL of the live
 * protocols in that category. A category with at least `model.min_category_comparables` live
 * comparables uses its median as-is. A thinner category (one or two comparables) does not get its
 * raw median: one observation can price at 400x TVL, so its median is first held inside
 * [`model.multiple_winsor_low`, `model.multiple_winsor_high`] times the global median, then blended
 * with the global median at a prior weight of `model.multiple_shrinkage_prior` protocols:
 * multiple = (n x held median + k x global) / (n + k). A category with no live comparables is not
 * in the map and scores at the global median. Clamped to the model's [floor, cap] band.
 */
export function categoryMultiples(protocols: SnapshotProtocol[], model: ModelConstants = MODEL): { byCategory: Map<string, number>; global: number } {
  const ratios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.gecko_id === null || p.symbol === null) continue; // live only
    if (!(p.mcap_usd > 0) || !(p.tvl_usd > 0)) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio)) continue;
    all.push(ratio);
    const key = p.category ?? 'Other';
    const list = ratios.get(key) ?? [];
    list.push(ratio);
    ratios.set(key, list);
  }
  all.sort((a, b) => a - b);
  const globalRaw = medianOf(all) ?? 0.2;
  const clamp = (n: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, n));
  const global = clamp(globalRaw);
  const byCategory = new Map<string, number>();
  for (const [key, list] of ratios) {
    list.sort((a, b) => a - b);
    const m = medianOf(list);
    if (m === null) continue;
    if (list.length >= model.min_category_comparables) {
      byCategory.set(key, clamp(m));
    } else {
      const held = Math.min(model.multiple_winsor_high * global, Math.max(model.multiple_winsor_low * global, m));
      byCategory.set(key, clamp((list.length * held + model.multiple_shrinkage_prior * global) / (list.length + model.multiple_shrinkage_prior)));
    }
  }
  return { byCategory, global };
}

/** The category multiple one protocol is scored with. */
export function multipleFor(p: SnapshotProtocol, multiples: { byCategory: Map<string, number>; global: number }): number {
  return multiples.byCategory.get(p.category ?? 'Other') ?? multiples.global;
}

/** The three factors and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiples: { byCategory: Map<string, number>; global: number },
  model: ModelConstants = MODEL,
): { implied: number; multiple: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const multiple = multipleFor(protocol, multiples);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult));
  return { implied, multiple, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * The watchlist's own exclusion, applied to the whole board: a wrapped, staked or bridged product
 * of a protocol whose token already trades is not a token prospect. The categories, the whole words
 * in the name and the exchange prefixes are the house rule's, quoted in the bounty text — WBTC,
 * Binance staked ETH and USDT0 are the examples it names.
 */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and none of the watchlist's exclusions
 * (an exchange, a bridge or liquid-staking product, a wrapped or staked product, an exchange's own
 * name, or a versioned pool). Every watchlist slug passes this test by construction.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORIES.has(p.category ?? '') &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name) &&
    !VERSIONED.test(p.name)
  );
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const multiples = categoryMultiples(snapshot.protocols, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, not just the richest few. The floor
  // is a floor, never a ceiling, and the early rows are the radar's whole point.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, multiples, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      // Full precision, not rounded: the dashboard recomputes the row from this multiple, and a
      // rounded copy would make its check disagree with board.json by a few dollars.
      category_multiple: s.multiple,
      growth_pct: round4(s.growthPct),
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A rough gas price for one transaction on a chain, for the plan's cost lines. */
function gasFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $12';
  if (c === 'solana') return 'about $0.10';
  if (c === 'binance') return 'about $0.30';
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'polygon' || c === 'monad') return 'about $1';
  return 'about $4';
}

/** The category's main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position supplied.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds inside its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one market position on an outcome you follow.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('farm')) return `Deposit $${capital} into ${name}'s farm on ${chain} and keep the deposit staked.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second qualifying action: a different touchpoint from the first deposit. */
function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $25 against your ${name} supply on ${chain}, then repay it the same week.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Swap $25 through ${name}'s main pool on ${chain} instead of adding more liquidity.`;
  if (c.includes('bridge')) return `Bridge $25 back through ${name} so the round trip is recorded on both chains.`;
  if (c.includes('staking') || c.includes('restak')) return `Claim or restake one reward distribution from ${name} on ${chain}.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Close the hedge on ${name} and open one fresh small position the next week.`;
  if (c.includes('prediction')) return `Settle or close the first market position on ${name} and open a second one later.`;
  if (c.includes('curator') || c.includes('allocator')) return `Move $25 between two ${name} vaults on ${chain} and keep the larger share.`;
  if (c.includes('stable')) return `Redeem $25 of the stable asset through ${name} on ${chain} and redeposit it.`;
  if (c.includes('rwa')) return `Reinvest one yield payout from ${name} on ${chain} into the same asset.`;
  if (c.includes('insurance')) return `Renew or extend the ${name} cover on ${chain} for a second short term.`;
  if (c.includes('farm')) return `Harvest one reward from ${name} on ${chain} and restake it the same day.`;
  return `Make one $25 swap through ${name} on ${chain} so a second action type is recorded.`;
}

/** The gas token a farmer holds on a chain, for the plan's first step. */
function gasTokenFor(chain: string): string {
  const c = chain.toLowerCase();
  if (
    c === 'ethereum' || c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'unichain' ||
    c === 'ink' || c === 'katana' || c === 'linea' || c === 'scroll' || c === 'zksync era' ||
    c === 'mode' || c === 'blast' || c === 'manta' || c === 'swellchain' || c === 'metis' ||
    c === 'taiko' || c === 'zircuit' || c === 'world chain' || c === 'x layer' || c === 'fraxtal' ||
    c === 'soneium' || c === 'morph' || c === 'lisk' || c === 'metal l2' || c === 'hemi' ||
    c === 'bob' || c === 'reya network' || c === 'megaeth' || c === 'robinhood chain'
  ) return 'ETH';
  if (c === 'solana') return 'SOL';
  if (c === 'binance' || c === 'op_bnb') return 'BNB';
  if (c === 'monad') return 'MON';
  if (c === 'hyperliquid l1') return 'HYPE';
  if (c === 'plasma') return 'XPL';
  if (c === 'avalanche') return 'AVAX';
  if (c === 'berachain') return 'BERA';
  if (c === 'polygon' || c === 'polygon zkevm') return 'POL';
  if (c === 'sonic') return 'S';
  if (c === 'flare') return 'FLR';
  if (c === 'bitcoin' || c === 'corn' || c === 'mezo' || c === 'bitlayer' || c === 'bsquared' || c === 'goat') return 'BTC';
  if (c === 'arc') return 'USDC';
  if (c === 'plume mainnet' || c === 'plume') return 'PLUME';
  if (c === 'stellar') return 'XLM';
  if (c === 'sui') return 'SUI';
  if (c === 'mantle') return 'MNT';
  if (c === 'tac') return 'TON';
  if (c === 'starknet') return 'STRK';
  if (c === 'sei') return 'SEI';
  if (c === 'stable') return 'USDT';
  if (c === 'tron') return 'TRX';
  if (c === 'aptos') return 'APT';
  if (c === 'near') return 'NEAR';
  if (c === 'cardano') return 'ADA';
  if (c === 'litecoin') return 'LTC';
  if (c === 'zcash') return 'ZEC';
  if (c === 'doge') return 'DOGE';
  if (c === 'flow') return 'FLOW';
  if (c === 'klaytn') return 'KLAY';
  if (c === 'astar') return 'ASTR';
  if (c === 'moonbeam') return 'GLMR';
  if (c === 'evmos') return 'EVMOS';
  if (c === 'apechain') return 'APE';
  if (c === 'nibiru') return 'NIBI';
  if (c === 'filecoin') return 'FIL';
  if (c === 'bittensor' || c === 'bittensor evm') return 'TAO';
  if (c === 'story') return 'IP';
  if (c === 'xion') return 'XION';
  if (c === 'peaq') return 'PEAQ';
  if (c === 'pulse') return 'PLS';
  if (c === 'ronin') return 'RON';
  if (c === 'fantom') return 'FTM';
  if (c === 'kava') return 'KAVA';
  if (c === 'celo') return 'CELO';
  if (c === 'algorand') return 'ALGO';
  if (c === 'rsk') return 'RBTC';
  if (c === 'etherlink') return 'XTZ';
  if (c === 'provenance') return 'HASH';
  if (c === 'ripple') return 'XRP';
  if (c === 'stacks') return 'STX';
  if (c === 'bifrost network') return 'BNC';
  if (c === 'zigchain') return 'ZIG';
  if (c === 'canton') return 'CC';
  if (c === 'proton') return 'XPR';
  if (c === 'qubic') return 'QUBIC';
  if (c === 'cronos') return 'CRO';
  if (c === 'babylon genesis') return 'BABY';
  if (c === 'aleo') return 'ALEO';
  return "the chain's gas token";
}

/** The category's weekly recurring action: a different touchpoint from the first deposit and the second action. */
function weeklyActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Each week, adjust a small part of your ${name} supply on ${chain} — add $25 or withdraw $25 — so the position stays active.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Each week, add $25 of liquidity to ${name}'s main pool on ${chain} and leave the older position untouched.`;
  if (c.includes('bridge')) return `Each week, check the ${name} bridge on ${chain} and move $25 across if the route is live.`;
  if (c.includes('staking') || c.includes('restak')) return `Each week, add a small amount to the ${name} stake on ${chain} so the position keeps growing.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Each week, add $25 of margin to your ${name} position on ${chain} or trim it back.`;
  if (c.includes('prediction')) return `Each week, place one small position on a ${name} market you follow.`;
  if (c.includes('curator') || c.includes('allocator')) return `Each week, add $25 to your largest ${name} vault share on ${chain}.`;
  if (c.includes('stable')) return `Each week, check the ${name} peg and yield on ${chain} and move $25 in or out.`;
  if (c.includes('rwa')) return `Each week, add $25 to the ${name} yield-bearing position on ${chain}.`;
  if (c.includes('insurance')) return `Each week, check that the ${name} cover on ${chain} is still active and top it up if it lapses.`;
  if (c.includes('farm')) return `Each week, add $25 to the ${name} farm deposit on ${chain} and keep the stake compounding.`;
  return `Each week, make one small swap or deposit through ${name} on ${chain} so the activity stays fresh.`;
}

/** Where the protocol's own points or rewards are checked, in the words of its category. */
function pointsPageFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `the Rewards tab of the ${name} app on ${chain}`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `the points or rewards page in the ${name} app on ${chain}`;
  if (c.includes('bridge')) return `the activity page of the ${name} bridge on ${chain}`;
  if (c.includes('staking') || c.includes('restak')) return `the staking dashboard of ${name} on ${chain}`;
  if (c.includes('perpetual') || c.includes('derivative')) return `the rewards panel of the ${name} trading app on ${chain}`;
  if (c.includes('prediction')) return `the portfolio page of ${name} on ${chain}`;
  if (c.includes('curator') || c.includes('allocator')) return `the vault page of ${name} on ${chain}`;
  if (c.includes('stable')) return `the dashboard of ${name} on ${chain}`;
  if (c.includes('rwa')) return `the holdings page of ${name} on ${chain}`;
  if (c.includes('insurance')) return `the policy page of ${name} on ${chain}`;
  if (c.includes('farm')) return `the farm page of ${name} on ${chain}`;
  return `the points page of the ${name} app on ${chain}`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (name, category, chains, TVL, age), never from a hand-written list
 * of names, and every step names what it costs and how long it takes. No two steps are generic: the
 * wallet step names the chain and its gas token, the weekly step names the category's recurring
 * action, the check step names where that category's points live, and the log step records the chain
 * and the position size.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const gasToken = gasTokenFor(chain);
  const action = actionFor(p, capital, chain);
  const second = secondActionFor(p, capital, chain);
  const weekly = weeklyActionFor(p, capital, chain);
  const points = pointsPageFor(p, chain);
  return [
    {
      text: `Open a fresh wallet for ${p.name} on ${chain}: fund it with ${gasToken} for gas and only the $${capital} you plan to farm, and keep its seed phrase offline.`,
      cost: `${gas} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and ${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: second,
      cost: `$25 of capital moved and ${gas} of gas`,
      time: '10 minutes',
    },
    {
      text: weekly,
      cost: `${gas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the $${capital} ${p.name} position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${points} and check the activity is counted, claiming only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the ${chain} gas spent, the $${capital} ${p.name} position and every transaction date in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const multiples = categoryMultiples(snapshot.protocols, model);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_multiple: round4(multiples.global),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
