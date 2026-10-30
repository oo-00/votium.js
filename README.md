# votium.js

Votium data for the v2 contracts: deposits, rounds, gauges and vote tallies for vlCVX (Curve and
f(x)) and veYB. Built on [cvxOnchain](https://github.com/oo-00/cvxOnchain) for on-chain votes.

## Install

```json
"dependencies": { "votium.js": "github:oo-00/votium.js#v2.0.0" }
```

## Use

```js
const votium = require('votium.js')({
    providers: { mainnet: process.env.RPC_URL },
    storage: require('votium.js/storage/local')('./storage'),
});

const round = votium.round();                          // current Curve round
const incentives = await votium.getIncentivesByRound(round, 0);
const table = await votium.roundObject(round - 1, 0);   // a finished round, with $/vote
```

Nothing is read and no RPC is made until you call a function. Options:

| Option | Meaning |
|---|---|
| `providers` | `{ mainnet: RPC URL }`, required. Votium's deposit contracts are all on mainnet |
| `storage` | where data is cached: `storage/local.js` (a folder), `storage/firebase.js` (a Realtime Database, with a path prefix and key map), or any `{ read(key, suffix), write(key, value, suffix) }` |
| `cvx` | a cvxonchain instance, if you already have one (otherwise one is built from `providers.mainnet`) |
| `logBlocksLimit` | max blocks per log query (default 10000, Infura's limit), used when reading a depositor's deposits |
| `prices` | `async (addresses) => ({ [address]: usd })` for `roundObject`'s USD figures. Without it, prices come from the `api/tokens` list in storage (the one Votium's price job writes, and the site and the reconcile read). DefiLlama's keyless API fills in when the list is missing or lacks a token |

Keys and credentials stay with you: pass RPC URLs and an initialized database. The package
contains none.

## Platforms

| `platform` | Market |
|---|---|
| 0 | Curve gauges, voted with vlCVX |
| 1 | *removed* (was Prisma); throws |
| 2 | f(x) gauges, voted with vlCVX |
| 3 | Yield Basis gauges, voted with veYB. Gauges come from the Yield Basis API (`api.yieldbasis.com`), with killed ones (checked on the gauge controller) left out and legacy markets labelled |

## Votes, opt-outs and maxPerVote

- `updateSnapshot(round, delay, platform)` tallies on-chain votes (Curve, f(x)), with delegated
  weight attributed to each delegator: the current proposal's whenever the stored tally is older
  than `delay`, and a finished proposal's once if nothing is stored for it (its votes stay on-chain).
  After that, rounds come from storage, as Snapshot-era rounds always do.
- Delegators are found in the locker list (`api/lockers`). With none stored, it's built from the
  last 20 weeks of vlCVX lock events; a list that carries `lastBlock` gets the lockers since then
  added before each tally, and is saved back if the storage accepts it.
- `snapshotVotes(round, platform)` re-tallies a round from the Snapshot era (Curve before
  round 128, f(x) before 63), for building a vote history. It needs an archive RPC. Round 95
  uses the votes captured during that round, which ship in `data/95snapShot.json` (v2's
  `95snapShot` node): 38 of its 68 votes are no longer on Snapshot, and reconcile paid them as
  captured.
- `withheldWeights(round, platform, gauges)` returns the vlCVX the opt-out registries withhold
  per gauge. Opted-out voters earn nothing on that gauge and don't dilute anyone.
- `optOuts` reads Votium's opt-out registries directly: `deployEpoch`, `optOutCounts`,
  `optedOutUsers` (paged, checked against the count), `withheldWeight` and `withheldByGauge`,
  by platform name (`"Curve"`, `"Fx"`) and proposal epoch. These are Votium's contracts, so
  they live here; cvxOnchain stays Convex-only.
- `roundObject(round, platform)` reports `earningVotes` per gauge (votes minus withheld weight).
  It pays a capped deposit `min(amount, maxPerVote × ceil(earning votes))`, as the
  contract and the reconcile do. The rest rolls over to the next round. A gauge with no
  earning votes consumes nothing, and its deposits roll over too. A deposit's excluded voters
  (rounds 104 and 105 had such deposits; reconcile no longer accepts them) come out of that
  deposit's earning votes.

## Examples

`examples/roundTable.js` (Curve) and `examples/roundTableFXN.js` print a round as a table;
`examples/examples.js` shows the other calls. Set `RPC_URL` first.

## Upgrading from v1

- `require('votium.js')` now returns a factory. Call it with your options.
- `.config.json` and `.storageConfig.js` are gone. Pass `providers` and `storage` instead.
  `storage/local.js` reads the v1 `storage/` folder layout as is. For Firebase, pass your v1
  path map as `paths`.
- Prisma (platform 1) is removed.
- The tally no longer writes to Firebase directly. It stores `api/delegateMap` through your
  storage adapter.
- `storage/firebase.js` throws on database errors: a failed read isn't mistaken for missing data.
- `generateVlCVXMerkle` (disabled since the legacy vlCVX contract) is removed, with the
  `vlCVXLocker` and `delegationRegistry` options and the merkletreejs, keccak256 and
  ethereum-block-by-date dependencies. `vlCVXMerkle()` still reads stored merkles.
- Built on ethers 6. `multicall.js` (ethers-multicall's call builders on Multicall3) replaces
  ethers-multicall and @pelith/ethers-multicall, which only work with ethers 5.
- L2 support is removed: the zkEVM vote platform (`l2votes()`, the `l2votePlatform` option) and
  the `zkevm`, `optimism` and `arbitrum` providers. Convex kept vlCVX voting on mainnet, and
  Votium's deposit contracts were never deployed on an L2. Data is still keyed by `mainnet`.
- The repository no longer carries a `storage/` data snapshot: a local store starts empty and
  fills as you call functions. Only round 95's vote capture ships, in `data/`.
