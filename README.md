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
| `providers` | RPC URLs by network. `mainnet` is required; `zkevm`, `optimism` and `arbitrum` are optional |
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

- `updateSnapshot(round, delay, platform)` tallies the current proposal's on-chain votes (Curve,
  f(x)), with delegated weight attributed to each delegator. Past rounds come from storage.
- `snapshotVotes(round, platform)` re-tallies a round from the Snapshot era (Curve before
  round 128, f(x) before 63), for building a vote history. It needs an archive RPC.
- `withheldWeights(round, platform, gauges)` returns the vlCVX the opt-out registries withhold
  per gauge. Opted-out voters earn nothing on that gauge and don't dilute anyone.
- `optOuts` reads Votium's opt-out registries directly: `deployEpoch`, `optOutCounts`,
  `optedOutUsers` (paged, checked against the count), `withheldWeight` and `withheldByGauge`,
  by platform name (`"Curve"`, `"Fx"`) and proposal epoch. These are Votium's contracts, so
  they live here; cvxOnchain stays Convex-only.
- `roundObject(round, platform)` reports `earningVotes` per gauge (votes minus withheld weight).
  It pays a capped deposit `min(amount, maxPerVote × ceil(earning votes))`, as the
  contract and the reconcile do. The rest rolls over to the next round. A gauge with no
  earning votes consumes nothing, and its deposits roll over too.

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
