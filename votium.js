// votium.js: Votium deposits, rounds, gauges and vote tallies for vlCVX (Curve, f(x)) and veYB.
//
//   const votium = require('votium.js')({
//       providers: { mainnet: process.env.RPC_URL },
//       storage: require('votium.js/storage/local')('./storage'),
//   });
//
// Options:
//   providers   { mainnet: RPC URL } (required): Votium's deposit contracts are all on mainnet
//   storage     { read(key, suffix), write(key, value, suffix) }: storage/local.js, storage/firebase.js,
//               or your own
//   cvx         a cvxonchain instance (built from providers.mainnet if left out)
//   logBlocksLimit  max blocks per log query, default 10000 (Infura's limit)
// Nothing is read and no RPC is made until a function is called.

// local json files
const deployments = require('./deployments.json');
const depositAbi = require('./abis/votium.json');
const depositVlcvxFXNAbi = require('./abis/votiumVlCVXFXN.json');
const depositVeYBAbi = require('./abis/votiumVeYB.json');
const erc20Abi = require('./abis/erc20.json');


// outside libraries
const { ethers } = require('ethers');
// multicall call builders (ethers-multicall's API, on ethers 6 and Multicall3), archive block tags included
const { Contract, Provider } = require('./multicall.js');
const fetch = require('node-fetch');

// Snapshot vote tallying: rounds before on-chain voting (history only)
const createSnap = require('./snap.js');

// on-chain vote tallying for Curve and f(x)
const createOnchainVotes = require('./onchainVotes.js');

// Votium's opt-out registries (Curve, f(x))
const createOptOuts = require('./optOuts.js');

// round start times, and the Convex proposal a round is voted on
const { roundEpoch, roundProposal } = require('./rounds.js');


// Platform slots: 0 Curve, 2 f(x), 3 YB. Slot 1 was Prisma, now removed; the numbers stay
// fixed so stored data and indexes keep their meaning.
const PRISMA = 1;
function noPrisma(platform) {
    if (platform == PRISMA) { throw new Error("Platform 1 (Prisma) was removed from votium.js"); }
}
const GAUGE_KEYS = ["gauges", null, "fxGauges", "ybGauges"];
const DEPOSIT_KEYS = ["depositData", null, "fxDepositData", "ybDepositData"];
const USER_DEPOSIT_KEYS = ["userDeposits", null, "fxUserDeposits", "ybUserDeposits"];
const VOTE_PLATFORMS = ["Curve", null, "Fx", null]; // cvxonchain names, for opt-out registries

module.exports = function votium(options = {}) {

const storage = options.storage;
if (!storage || typeof storage.read !== "function" || typeof storage.write !== "function") {
    throw new Error("votium.js: pass a storage adapter { read, write }, e.g. require('votium.js/storage/local')(dir)");
}
const config = {
    logBlocksLimit: 10000, // max blocks per log query (Infura's limit)
    ...options,
    providers: { ...(options.providers || {}) }
};
if (!config.providers.mainnet) {
    throw new Error("votium.js: pass providers.mainnet");
}
const cvx = options.cvx || require('cvxonchain')({ rpc: config.providers.mainnet });
const snap = createSnap({ storage, rpc: config.providers.mainnet });
const onchainVotes = createOnchainVotes({ storage, cvx });
const optOuts = createOptOuts({ cvx });

// declaring some variables used in multiple scopes


var coingecko = "https://api.coingecko.com/api/v3/simple/token_price/ethereum?vs_currencies=usd&contract_addresses=";

// USD prices by token address, for roundObject (see _prices). DefiLlama is the fallback: its
// keyless API takes a batch of addresses, while CoinGecko's keyless by-address endpoint
// (simple/token_price) is capped at one address per request (error 10012).
var defillama = "https://coins.llama.fi/prices/current/";
async function _defillamaPrices(addresses) {
    var out = {};
    for (var s = 0; s < addresses.length; s += 100) {
        var res = await fetch(defillama + addresses.slice(s, s + 100).map((a) => "ethereum:" + a).join(","));
        if (!res.ok) {
            console.log("defillama returned HTTP " + res.status + " for prices");
            continue;
        }
        var body = await res.json();
        for (var key in body.coins) {
            var address = key.split(":")[1];
            if (ethers.isAddress(address)) { out[ethers.getAddress(address)] = body.coins[key].price; }
        }
    }
    return out;
}

// USD prices by token address: options.prices if given; else the api/tokens price list in
// storage (written by Votium's price job, and read by the site and the reconcile; keys are
// upper-cased addresses); DefiLlama for the whole set if that list is missing, or for any
// token it lacks.
async function _prices(addresses) {
    if (config.prices) { return await config.prices(addresses); }
    var out = {};
    var missing = [];
    var list = await storage.read("api/tokens/");
    for (var a of addresses) {
        var price = list ? list[a.toUpperCase()] : undefined;
        if (price !== undefined && price !== null && !isNaN(Number(price))) {
            out[ethers.getAddress(a)] = Number(price);
        } else {
            missing.push(a);
        }
    }
    if (missing.length > 0) {
        if (list) { console.log(missing.length + " token(s) not in api/tokens, priced from DefiLlama: " + missing.join(", ")); }
        Object.assign(out, await _defillamaPrices(missing));
    }
    return out;
}

// [platform]: Curve, (Prisma, removed), f(x). YB gauges are set in _getGauges.
const GaugeEndpoint = ["https://api.curve.finance/api/getAllGauges", null, "https://api.aladdin.club/api1/get_fx_gauge_list"];

// Yield Basis: its API lists the gauges (in gauge controller order) and flags legacy markets; the
// controller says which are killed
const YB_API = "https://api.yieldbasis.com";
const YB_CONTROLLER = "0x1be14811a3a06f6af4fa64310a636e1df04c1c21";
const ybControllerIface = new ethers.Interface(["function n_gauges() view returns (uint256)", "function is_killed(address) view returns (bool)"]);
const symbolIface = new ethers.Interface(["function symbol() view returns (string)"]);
const erc20Iface = new ethers.Interface(erc20Abi);

var calls = {};
var providers = {};
var mProviders = {};
var contracts = [{},{},{},{}];
var mContracts = [{},{},{},{}];
var round = [];
round[0] = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 14)) - 1348;
round[2] = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 14)) - 1413;
round[3] = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 7)) - 2910;
var Gauges = []; // per platform, loaded from storage on first use (_loadGauges)


for(var ri in round) {
    if(ri != 3) {
        if(Math.floor(Date.now()/1000)-roundEpoch(round[ri], ri) > 60*60*24*5) round[ri]++; // if vote is over, default to next round
    }
}

// Initialize providers and votium deposit contracts (single and multicall)

// The mainnet provider and Votium's deposit contracts (single calls and multicall). Data stays keyed by network
// ("mainnet"), as v1 stored it. A fixed network: no chain id lookups, and no endless startup retries when the RPC
// is down.
providers.mainnet = new ethers.JsonRpcProvider(config.providers.mainnet, 1, { staticNetwork: true });
mProviders.mainnet = new Provider(providers.mainnet);
for (const [platform, name, abi] of [[0, "vlcvxCurveFrax", depositAbi], [2, "vlcvxFXN", depositVlcvxFXNAbi], [3, "veYB", depositVeYBAbi]]) {
    contracts[platform].mainnet = new ethers.Contract(deployments[name].mainnet, abi, providers.mainnet);
    mContracts[platform].mainnet = new Contract(deployments[name].mainnet, abi);
}

// a token's symbol: a string, or bytes32 for some older tokens (MKR, say); null if it's neither
function _decodeSymbol(data) {
    try { return erc20Iface.decodeFunctionResult("symbol", data)[0]; } catch (e) {}
    try { return ethers.decodeBytes32String(ethers.dataSlice(data, 0, 32)); } catch (e) {}
    return null;
}

// decimals and symbol of each deposited token (the deposit contracts are on mainnet). A token that reverts on
// either, or answers in a form that won't decode, gets 18 decimals or its address as the symbol, so one odd token
// doesn't fail the whole round's read.
async function _getTokenInfoFromIncentives(network, incentivesRaw) {
    var decimals = {};
    var symbols = {};
    var tokens = [...new Set(incentivesRaw.map((x) => x.token))];
    var leaves = [];
    for (var t of tokens) {
        leaves.push({ target: t, callData: erc20Iface.encodeFunctionData("decimals"), allowFailure: true, decode: (d) => { try { return Number(erc20Iface.decodeFunctionResult("decimals", d)[0]); } catch (e) { return null; } } });
        leaves.push({ target: t, callData: erc20Iface.encodeFunctionData("symbol"), allowFailure: true, decode: _decodeSymbol });
    }
    var results = tokens.length > 0 ? await cvx.batchCall(leaves) : [];
    var unknownDecimals = new Set();
    tokens.forEach((t, k) => {
        decimals[t] = results[2 * k] != null ? results[2 * k] : 18;
        if (results[2 * k] == null) { unknownDecimals.add(t); }
        symbols[t] = results[2 * k + 1] != null ? results[2 * k + 1] : t;
        if (results[2 * k] == null || results[2 * k + 1] == null) {
            console.log("Token " + t + ": " + (results[2 * k] == null ? "no decimals(), using 18" : "") + (results[2 * k + 1] == null ? " no readable symbol(), using its address" : ""));
        }
    });
    // unknownDecimals: tokens whose 18 decimals is assumed, not read; their deposits carry decimalsUnknown: true
    return { decimals: decimals, symbols: symbols, unknownDecimals: unknownDecimals };
}
// storage key for a platform's gauge list
function gaugeKey(platform) {
    noPrisma(platform);
    return GAUGE_KEYS[platform];
}

// the platform's gauge list: what updateGauges() last loaded, else what storage holds
async function _loadGauges(platform) {
    Gauges[platform] = await Promise.resolve(Gauges[platform]);
    if (Gauges[platform] == undefined) { Gauges[platform] = await storage.read(gaugeKey(platform)); }
    return (Gauges[platform] && Gauges[platform].gauges) ? Gauges[platform] : { gauges: {} };
}

// vlCVX withheld by the opt-out registries, per gauge, at the round's proposal epoch.
// Curve and f(x) only; empty before the registries existed or before the proposal does.
async function _withheld(_round, platform, gauges) {
    var name = VOTE_PLATFORMS[platform];
    if (name == null || gauges.length == 0) { return {}; }
    var proposalId = roundProposal(_round, platform);
    var epoch;
    try {
        epoch = Number((await cvx.gaugeProposals(name, proposalId)).epoch);
    } catch (e) {
        return {}; // no proposal for this round yet
    }
    return await optOuts.withheldByGauge(name, gauges, epoch);
}

// get incentives for a specified network and round number
async function _getIncentives(network, _round, platform=0) {
    var info, decimals, symbols, poolName, active;
    
    // initialize providers and contracts
    await mProviders[network].init()
    var gaugeList = await _loadGauges(platform);

    if (!contracts[platform][network]) return null;
    
    // declare arrays we will need
    var gauges = [];
    var incentives = {};
    var incentivesRaw = [];
    var incentivesLengths = [];
    // single call, since we're dealing with only 1 round
    var gaugesLength = await contracts[platform][network].gaugesLength(_round); 

    // get gauges for round
    calls[network] = [];
    for (var i = 0; i < gaugesLength; i++) {
        calls[network].push(mContracts[platform][network].roundGauges(_round, i));
    }
    try {
        gauges = await mProviders[network].all(calls[network]);
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get gauges for " + network);
        return null;
    }

    // get incentives lengths for each gauge
    calls[network] = [];
    for (var i = 0; i < gauges.length; i++) {
        calls[network].push(mContracts[platform][network].incentivesLength(_round, gauges[i]));
    }
    try {
        incentivesLengths = await mProviders[network].all(calls[network]);
    }
    catch (e) {
        console.log("Error: " + e);
        console.log("Could not get incentives lengths for " + network + " round " + _round + " gauge " + gauges[i]);
        return null;
    }
    // get all incentives for each gauge
    calls[network] = [];
    for (var i = 0; i < gauges.length; i++) {
        for (var j = 0; j < incentivesLengths[i]; j++) {
            calls[network].push(mContracts[platform][network].viewIncentive(_round, gauges[i], j));
        }
    }
    try {
        // raw data before adding decimals
        incentivesRaw = await mProviders[network].all(calls[network]);
    }
    catch (e) {
        console.log("Error: " + e);
        console.log("Could not get incentives for " + network + " round " + _round + " gauge " + gauges[i] + " incentive " + j);
        return null;
    }

    info = await _getTokenInfoFromIncentives(network, incentivesRaw);
    decimals = info.decimals;
    symbols = info.symbols;

    // the list's entries by lowercase address (its keys are checksummed; lists stored before 2.0.0 had one
    // lowercase key)
    var listed = {};
    for (var fg in gaugeList.gauges) { listed[fg.toLowerCase()] = gaugeList.gauges[fg]; }

    // build incentives object
    var n = 0; // map counter
    // building in the same way as we built the calls for incentivesRaw
    for (var i = 0; i < gauges.length; i++) {
        incentives[gauges[i]] = []; // initialize gauge incentive array

        var entry = listed[gauges[i].toLowerCase()];
        if(entry == undefined) {
            poolName = "Unknown (" + gauges[i].substr(0,6) + "...)";
            active = false;
        } else {
            poolName = entry.shortName;
            active = entry.active;
        }
        for (var j = 0; j < incentivesLengths[i]; j++) {
            incentives[gauges[i]][j] = {
                "index": j,
                "pool": poolName,
                "token": incentivesRaw[n].token,
                "symbol": symbols[incentivesRaw[n].token],
                "decimals": decimals[incentivesRaw[n].token],
                "amount": incentivesRaw[n].amount.toString(),
                "maxPerVote": incentivesRaw[n].maxPerVote.toString(),
                "excluded": incentivesRaw[n].excluded,
                "depositor": incentivesRaw[n].depositor,
                "poolActive": active,
            };
            if (info.unknownDecimals.has(incentivesRaw[n].token)) { incentives[gauges[i]][j].decimalsUnknown = true; }
            // if _round is earlier than current round, include additional data
            if(_round < round[platform]) {
                incentives[gauges[i]][j].distributed = incentivesRaw[n].distributed.toString();
                incentives[gauges[i]][j].recycled = incentivesRaw[n].recycled.toString();
            }
            n++;
        }
    }

    return incentives;
}

// NewIncentive logs of a deposit contract from fromBlock to toBlock (both inclusive), of one depositor or (null)
// all of them, in non-overlapping windows of logBlocksLimit blocks: RPCs cap a log query's block range (Infura:
// 10,000). v1's [start, start + 100000] windows, which also reused endBlock as the next start, were rejected.
async function _newIncentiveLogs(network, platform, fromBlock, toBlock, depositor = null) {
    var windows = [];
    for (var start = fromBlock; start <= toBlock; start += config.logBlocksLimit) {
        windows.push([start, Math.min(start + config.logBlocksLimit - 1, toBlock)]);
    }
    // a few windows at a time: some RPCs reject large batches or bursts of log queries
    var depositContract = contracts[platform][network];
    var filter = depositContract.filters.NewIncentive(null, null, null, null, null, null, null, depositor);
    var events = [];
    for (var w = 0; w < windows.length; w += 4) {
        var batch = await Promise.all(windows.slice(w, w + 4).map(([from, to]) => depositContract.queryFilter(filter, from, to)));
        for (var b of batch) { events = events.concat(b); }
    }
    return events;
}

// add NewIncentive logs to a { round: { gauge: [incentive indexes] } } map
function _addIncentiveIds(into, events) {
    for (var e of events) {
        var r = e.args._round.toString();
        var g = e.args._gauge;
        var id = e.args._index.toString();
        if (into[r] == undefined) into[r] = {};
        if (into[r][g] == undefined) into[r][g] = [];
        if (!into[r][g].includes(id)) into[r][g].push(id);
    }
    return into;
}

// get incentives for a specified network and depositor: the ones in found ({ round: { gauge: [indexes] } }), or
// else the ones the depositor made in the last 200,000 blocks
async function _getIncentivesByUser(network, user, platform=0, found=null) {
    var i, r, g, n, userIncentives, incentivesRaw, info, decimals;
    // initialize providers and contracts
    await mProviders[network].init()
    var gaugeList = await _loadGauges(platform);

    if (!contracts[platform][network]) return null;

    if (found) {
        // a copy: the indexes are replaced by the deposits below
        userIncentives = {};
        for (r in found) {
            userIncentives[r] = {};
            for (g in found[r]) { userIncentives[r][g] = [...found[r][g]]; }
        }
    } else {
        var currentBlock = await providers[network].getBlockNumber();
        // the last 200,000 blocks (about 28 days): deposits from before that are kept from the stored record
        // (see getIncentivesByUser), so each refresh only reads the recent ones
        userIncentives = _addIncentiveIds({}, await _newIncentiveLogs(network, platform, currentBlock - 200000, currentBlock, user));
    }


    // get deposit data for each incentive
    calls[network] = [];
    for(r in userIncentives) {
        for(g in userIncentives[r]) {
            for(i in userIncentives[r][g]) {
                calls[network].push(mContracts[platform][network].viewIncentive(r, g, userIncentives[r][g][i]));
            }
        }
    }
    try {
        // raw data before adding decimals
        incentivesRaw = await mProviders[network].all(calls[network]);
    }
    catch (e) {
        console.log("Error: " + e);
        console.log("Could not get incentives for " + network + " depositor " + user);
        return null;
    }

    info = await _getTokenInfoFromIncentives(network, incentivesRaw);
    decimals = info.decimals;

    // the list's entries by lowercase address, as in _getIncentives
    var listed = {};
    for (var fg in gaugeList.gauges) { listed[fg.toLowerCase()] = gaugeList.gauges[fg]; }

    // build incentives object
    var n = 0; // map counter
    // building in the same way as we built the calls for incentivesRaw
    for(r in userIncentives) {
        for(g in userIncentives[r]) {
            // a gauge missing from the list (killed or delisted since) keeps its deposits, named as _getIncentives
            // names it: the depositor may still be able to withdraw them
            var entry = listed[g.toLowerCase()];
            for(i in userIncentives[r][g]) {
                userIncentives[r][g][i] = {
                    "index": userIncentives[r][g][i],
                    "pool": entry ? entry.shortName : "Unknown (" + g.substr(0,6) + "...)",
                    "token": incentivesRaw[n].token,
                    "decimals": decimals[incentivesRaw[n].token],
                    "amount": incentivesRaw[n].amount.toString(),
                    "maxPerVote": incentivesRaw[n].maxPerVote.toString(),
                    "excluded": incentivesRaw[n].excluded
                };
                if (info.unknownDecimals.has(incentivesRaw[n].token)) { userIncentives[r][g][i].decimalsUnknown = true; }
                // if the round is earlier than the current one, include additional data
                if(Number(r) < round[platform]) {
                    userIncentives[r][g][i].distributed = incentivesRaw[n].distributed.toString();
                    userIncentives[r][g][i].recycled = incentivesRaw[n].recycled.toString();
                    userIncentives[r][g][i].depositor = incentivesRaw[n].depositor.toString();
                }
                n++;
            }
        }
    }
    return userIncentives;
}

// update gauges storage
async function _getGauges(platform=0) {
    var i;
    var pointer = gaugeKey(platform);

    Gauges[platform] = await storage.read(pointer);

    if (Gauges[platform] == undefined) { Gauges[platform] = {}; }
    if (Gauges[platform].lastUpdated == undefined) { Gauges[platform].lastUpdated = 0; }
    // v1 stored the hardcoded YB list with a far-future date so it never refreshed
    if (Gauges[platform].lastUpdated > Math.floor(Date.now() / 1000)) { Gauges[platform].lastUpdated = 0; }
    if (Math.floor(Date.now() / 1000) - Gauges[platform].lastUpdated < 60 * 60 * 8) { return; }

    // build the new list on the side
    var updated = { lastUpdated: Math.floor(Date.now() / 1000), gauges: {}};

    if(platform == 3) {
        // Yield Basis: gauges and legacy flags from its API, killed flags and token symbols from
        // the gauge controller (the API doesn't mark killed gauges). Killed gauges are left out,
        // as for Curve. If the API fails, the stored list is kept.
        var list, latest;
        console.log("Updating gauges for platform " + platform);
        try {
            list = await fetch(YB_API + "/v1/analytics/gauges?chainId=1").then(res => res.json());
            latest = await fetch(YB_API + "/v1/analytics/gauges/snapshots?chainId=1&window=all&timeframeSeconds=86400&includeLegacy=true&latest=true").then(res => res.json());
        } catch (e) {
            console.log("Error: " + e);
            console.log("Could not get Yield Basis gauges");
            return null;
        }
        if (list.success != true || !Array.isArray(list.data) || list.data.length == 0) { return; } // do not update if api returns error
        var legacy = {};
        if (latest && latest.success == true && Array.isArray(latest.data)) {
            for (var row of latest.data) { legacy[row.gaugeAddress.toLowerCase()] = row.isLegacy == 1; }
        }
        var ybCalls = [{ target: YB_CONTROLLER, callData: ybControllerIface.encodeFunctionData("n_gauges"), decode: (d) => Number(ybControllerIface.decodeFunctionResult("n_gauges", d)[0]) }];
        for (var entry of list.data) {
            ybCalls.push({ target: YB_CONTROLLER, callData: ybControllerIface.encodeFunctionData("is_killed", [entry.address]), decode: (d) => ybControllerIface.decodeFunctionResult("is_killed", d)[0] });
            ybCalls.push({ target: entry.ltAddress, callData: symbolIface.encodeFunctionData("symbol"), decode: (d) => symbolIface.decodeFunctionResult("symbol", d)[0] });
        }
        var ybResults = await cvx.batchCall(ybCalls);
        if (ybResults[0] != list.data.length) {
            console.log("Yield Basis API lists " + list.data.length + " gauges, the gauge controller has " + ybResults[0]);
        }
        for (var q = 0; q < list.data.length; q++) {
            if (ybResults[1 + 2 * q]) { continue; } // killed
            var ybGauge = ethers.getAddress(list.data[q].address);
            updated.gauges[ybGauge] = {
                "shortName": ybResults[2 + 2 * q] + (legacy[ybGauge.toLowerCase()] ? " legacy" : "") + " (" + ybGauge.slice(0, 6) + "…)",
                "active": true
            };
        }
    } else {
        var GaugesRaw = [];
        console.log("Updating gauges for platform " + platform)
        try {
            GaugesRaw = await fetch(GaugeEndpoint[platform]).then(res => res.json());
        } catch (e) {
            console.log("Error: " + e);
            console.log("Could not get gauges");
            return null;
        }
        if (GaugesRaw.success != true && GaugesRaw.msg != 'success') { return; } // do not update if  api returns error
        GaugesRaw = GaugesRaw.data; // remove success and data keys

        if(platform == 0) {
            for (i in GaugesRaw) {
                var gaugeAddress;
                if(GaugesRaw[i].rootGauge == undefined) {
                    gaugeAddress = ethers.getAddress(GaugesRaw[i].gauge);
                } else {
                    gaugeAddress = ethers.getAddress(GaugesRaw[i].rootGauge);
                }
                updated.gauges[gaugeAddress] = {
                    "shortName": GaugesRaw[i].shortName,
                    "active": (GaugesRaw[i].hasNoCrv == false && GaugesRaw[i].is_killed == false),
                }
                if(updated.gauges[gaugeAddress].active == false) {
                    delete updated.gauges[gaugeAddress];
                }
            }
            // a reply with no live gauges isn't a gauge list: keep the old one
            if (Object.keys(updated.gauges).length == 0) {
                console.log("The Curve gauge API returned no gauges; keeping the stored list");
                return;
            }
            var veFunder = ethers.getAddress("0xbaf05d7aa4129ca14ec45cc9d4103a9ab9a9ff60");
            if(updated.gauges[veFunder] == undefined) {
                updated.gauges[veFunder] = {
                    "shortName": "VeFunder-vyper",
                    "active": true
                }
            }
        } else if(platform == 2) {
            var gauge = {};
            for (i in GaugesRaw) {
                var ic = ethers.getAddress(i);
                gauge[ic] = {active:true, shortName:GaugesRaw[i].name};
            }
            if (Object.keys(gauge).length == 0) {
                console.log("The f(x) gauge API returned no gauges; keeping the stored list");
                return;
            }
            updated = {gauges: gauge, lastUpdated: Math.floor(Date.now() / 1000)};
        }
    }
    // the new list replaces the old one only now: if an API failed above, the instance keeps the old list
    Gauges[platform] = updated;
    // save gauges to storage
    await storage.write(pointer, updated);
}

// export functions
const api = {
    // the opt-out registry reads (deployEpoch, optOutCounts, optedOutUsers, withheldWeight,
    // withheldByGauge), by cvxonchain platform name ("Curve", "Fx") and proposal epoch
    optOuts: optOuts,
    round: function (platform=0) {
        return round[platform]; // current round
    },
    networks: function (platform=0) {
        return Object.keys(contracts[platform]); // supported networks
    },
    storageType: storage.storageType, // storage type
    // direct storage read
    storageRead: async function (key, suffix = "") {
        return await storage.read(key, suffix);
    },
    vlCVXMerkle: async function (_round = 0) {
        if(_round == 0) _round = this.round();
        return await storage.read("vlCVXMerkles", _round);
    },
    gauges: async function (platform=0) {
        return (await _loadGauges(platform)).gauges;
    },
    // get cached incentives for a given round
    getIncentivesCached: async function (_round = 0, platform=0) {
        noPrisma(platform);
        if(_round == 0) _round = this.round(platform);
        return await storage.read(DEPOSIT_KEYS[platform], _round);
    },
    // get incentives for a given round, using an optional offset from the current round
    getIncentivesByOffset: async function (roundOffset = 0, platform=0) {
        var roundd;
        roundd = this.round(platform);
        return await this.getIncentivesByRound(roundd + roundOffset, platform);
    },
    // get incentives for a given round
    getIncentivesByRound: async function (_round = 0, platform=0) {
        var chain, j, k;
        noPrisma(platform);
        if(_round == 0) _round = this.round(platform);
        var incentives = {};
        var promises = [];
        // batch promises for each network
        for (chain in contracts[platform]) {
            promises.push(_getIncentives(chain, _round, platform));
        }
        var results = await Promise.all(promises);
        var n = 0; // map counter
        for (chain in contracts[platform]) {
            if (results[n] == null) { n++; continue; } // skip if null
            if(!incentives[chain]) incentives[chain] = {}; // initialize chain object
            for (j in results[n]) {
                if (!incentives[chain][j]) incentives[chain][j] = [];
                for (k in results[n][j]) {
                    incentives[chain][j].push(results[n][j][k]);
                }
            }
            n++; // iterate through chains
        }
        // save to storage
        if(Object.keys(incentives).length === 0) { return null; }
        await storage.write(DEPOSIT_KEYS[platform], incentives, _round);
        return incentives;
    },
    // update list of gauges from platform api (max once per day)
    updateGauges: async function (platform=0) {
        await _getGauges(platform);
        return Gauges[platform];
    },
    // update the vote tally for a round, if older than delay (see onchainVotes.js). Pass your own voter address
    // for a what-if: the tally leaves that address's vote out, to help work out its next vote, and isn't saved.
    updateSnapshot: async function (_round = 0, delay = 0, platform=0, voter=null) {
        if(platform == 3) {
            return null;
        }
        noPrisma(platform);
        if(_round == 0) _round = this.round(platform);
        // Curve (0) and f(x) (2) vote on-chain: the current proposal is re-tallied when its stored tally is
        // older than delay, and a finished one is tallied once if nothing is stored for it. Stored rounds, and the
        // Snapshot-era ones (Curve before round 128, f(x) before round 63), come from storage.
        var shot = await onchainVotes.updateVotes(delay, _round, platform, voter);
        return shot;
    },
    // Re-tally a Snapshot-era round from Snapshot, for building the vote history.
    // Needs an archive RPC; results are stored like updateSnapshot's.
    snapshotVotes: async function (_round, platform=0, delay=0) {
        noPrisma(platform);
        return await snap.updateSnapshot(delay, _round, platform);
    },
    // vlCVX withheld by the opt-out registries per gauge for a round (Curve and f(x))
    withheldWeights: async function (_round = 0, platform=0, gauges = []) {
        noPrisma(platform);
        if(_round == 0) _round = this.round(platform);
        return await _withheld(_round, platform, gauges);
    },
    // USD prices by token address: options.prices, else api/tokens from storage, else DefiLlama
    prices: async function (addresses) {
        return await _prices(addresses);
    },
    // get prices from coingecko by address: the keyless by-address endpoint takes one address (see prices())
    coingecko: async function (tokenString) {
        var res = await fetch(coingecko + tokenString);
        var body = await res.json();
        var formatted = {};
        for(var key in body) {
            // rate limits and errors come back as non-price fields (status, timestamp): skip them
            if(!ethers.isAddress(key) || body[key] == null || body[key].usd == undefined) { continue; }
            formatted[ethers.getAddress(key)] = body[key].usd;
        }
        if(Object.keys(formatted).length == 0 && tokenString != "") {
            console.log("coingecko returned no prices (HTTP " + res.status + ")");
        }
        return formatted;
    },
    // NewIncentive logs from fromBlock to toBlock (both inclusive), by depositor:
    // { depositor: { network: { round: { gauge: [indexes] } } } }. Pass a depositor's entry to getIncentivesByUser
    // to store those deposits whenever they were made.
    newIncentivesByDepositor: async function (fromBlock, toBlock, platform=0) {
        noPrisma(platform);
        var byDepositor = {};
        for (var network in contracts[platform]) {
            var events = await _newIncentiveLogs(network, platform, fromBlock, toBlock);
            for (var e of events) {
                var d = e.args._depositor;
                if (byDepositor[d] == undefined) byDepositor[d] = {};
                if (byDepositor[d][network] == undefined) byDepositor[d][network] = {};
                _addIncentiveIds(byDepositor[d][network], [e]);
            }
        }
        return byDepositor;
    },
    // the deposits in rounds fromRound to toRound (both inclusive), by depositor, in newIncentivesByDepositor's
    // shape, read from the deposit contract's state instead of its logs: for a backfill, a few rounds cost a few
    // multicalls where logs from the contract's deployment cost thousands of log queries. Nothing is stored
    // (getIncentivesByRound caches each round it reads, which alerts compare against). null if a read fails.
    incentivesByDepositorInRounds: async function (fromRound, toRound, platform=0) {
        noPrisma(platform);
        var byDepositor = {};
        for (var network in contracts[platform]) {
            for (var r = fromRound; r <= toRound; r++) {
                var deposits = await _getIncentives(network, r, platform);
                if (deposits == null) return null;
                for (var g in deposits) {
                    for (var d of deposits[g]) {
                        var into = byDepositor[d.depositor] = byDepositor[d.depositor] || {};
                        into = into[network] = into[network] || {};
                        into = into[String(r)] = into[String(r)] || {};
                        (into[g] = into[g] || []).push(String(d.index));
                    }
                }
            }
        }
        return byDepositor;
    },
    // a depositor's deposits, merged into the stored record: the ones in found ({ network: { round: { gauge:
    // [indexes] } } }, from newIncentivesByDepositor or incentivesByDepositorInRounds), or else the ones made in
    // the last 200,000 blocks
    getIncentivesByUser: async function (user, platform=0, found=null) {
        var i, r, g;
        noPrisma(platform);
        var promises = [];
        for (i in contracts[platform]) {
            promises.push(_getIncentivesByUser(i, user, platform, found ? (found[i] || {}) : null));
        }
        var results = await Promise.all(promises);
        // a read that failed would otherwise replace the stored record with nothing
        if (results.some((x) => x == null)) {
            console.log("Deposits for " + user + " not updated: a read failed");
            return null;
        }
        var incentives = {};
        var n = 0; // map counter
        for(i in contracts[platform]) {
            for(r in results[n]) {
                if(!incentives[r]) incentives[r] = {};
                if(!incentives[r][i]) incentives[r][i] = {};
                for(g in results[n][r]) {
                    incentives[r][i][g] = results[n][r][g];
                }
            }
            n++;
        }
        // only some deposits were read (recent ones, or the found ones): stored deposits that weren't are kept, and
        // the ones that were are replaced by what was read
        var stored = await storage.read(USER_DEPOSIT_KEYS[platform], user.toLowerCase());
        for (r in stored || {}) {
            for (i in stored[r] || {}) {
                for (g in stored[r][i] || {}) {
                    var seen = (incentives[r] && incentives[r][i] && incentives[r][i][g]) || [];
                    var seenIndexes = new Set(seen.map((d) => String(d.index)));
                    var older = Object.values(stored[r][i][g] || {}).filter((d) => d != null && !seenIndexes.has(String(d.index)));
                    if (older.length == 0) { continue; }
                    if (!incentives[r]) incentives[r] = {};
                    if (!incentives[r][i]) incentives[r][i] = {};
                    incentives[r][i][g] = seen.concat(older).sort((a, b) => Number(a.index) - Number(b.index));
                }
            }
        }
        // save to storage
        await storage.write(USER_DEPOSIT_KEYS[platform], incentives, user.toLowerCase());
        
        return incentives;
    },
    // combine several functions to return a full round object
    roundObject : async function (_round = 0, platform=0) {
        var shot, Gauge, prices, chain, gauge, g, i;
        if(platform == 3) { 
            return null;
        }
        if(_round == 0) _round = this.round(platform);
        Gauges[platform] = await this.updateGauges(platform); // grabs gauges storage and updates if data more than 24 hours old
        var incentives = await this.getIncentivesByRound(_round, platform); // get incentives for round
        
        shot = await this.updateSnapshot(_round, 60 * 15, platform); // update if more than 15 minutes, and not finalized
        if (shot.votes == undefined) {
            console.log("Snapshot not available for round " + _round + ", platform " + platform);
            shot.votes = {gauges: {}};
        }
        shot = shot.votes.gauges; // removing some unused data

        // earning votes: opted-out weight comes out of each gauge's total
        var withheld = await _withheld(_round, platform, Object.keys(shot));

        Gauge = (Gauges[platform] && Gauges[platform].gauges) || {};
        
        // get prices for every token deposited this round
        var priceTokens = new Set();
        for (chain in incentives) {
            for (g in incentives[chain]) {
                for (i in incentives[chain][g]) {
                    priceTokens.add(incentives[chain][g][i].token);
                }
            }
        }
        prices = await this.prices([...priceTokens]);



        var totalUSD = 0; // total USD available for all gauges
        var totalConsumedUSD = 0; // total USD consumed for all gauges
        var gaugeUSD = {}; // USD available for each gauge
        var gaugeConsumedUSD = {}; // USD consumed for each gauge
        var possibleTotalUSD = 0; // total USD available for all gauges, assuming 25m vlCVX voted for gauges with maxPerVote
        var possibleGaugeUSD = {}; // USD available for each gauge, assuming 25m vlCVX voted for gauges with maxPerVote

        var displayObject = {};
        var unpriced = new Set(); // tokens without a USD price, counted at $0
        // cycle through different supported networks
        for (chain in incentives) {
            var totalVotes = 0; // total votes for all gauges
            var totalEarning = 0; // their earning votes
            var pervls = [];
            displayObject[chain] = {gauges: {}};
            // cycle through different gauges
            for (gauge in incentives[chain]) {
                // set initial object entry values to 0
                gaugeUSD[gauge] = 0;
                gaugeConsumedUSD[gauge] = 0;
                possibleGaugeUSD[gauge] = 0;

                // if gauge is not in snapshot, skip
                if (shot[gauge] == undefined) {
                    if (Gauge[gauge] == undefined) continue;
                    if(Gauge[gauge].active == false) continue;
                    var vote = { total: 0 };
                } else {
                    var vote = shot[gauge]; // for readability
                }
                
                var earning = Math.max(0, vote.total - (withheld[gauge] || 0));
                // a gauge with votes may be missing from the list (killed gauges are left out of it)
                var name = Gauge[gauge] ? Gauge[gauge].shortName : "Unknown (" + gauge + ")";
                // voters by lowercase address, for deposits' excluded lists (Snapshot-era shots used checksummed keys)
                var votesLower = {};
                for (var voterKey in (vote.votes || {})) { votesLower[voterKey.toLowerCase()] = vote.votes[voterKey]; }
                displayObject[chain].gauges[name] = {};
                displayObject[chain].gauges[name].votes = vote.total;
                displayObject[chain].gauges[name].earningVotes = earning;
                displayObject[chain].gauges[name].rewards = [];
                totalVotes += vote.total;
                totalEarning += earning;
                //console.log("   Votes for gauge: " + vote.total);
                //console.log("   Rewards for gauge:");
                for (i in incentives[chain][gauge]) {
                    // a copy: the deposit getIncentivesByRound returned (and stored) keeps its raw amounts
                    var incentive = Object.assign({}, incentives[chain][gauge][i]);
                    var price = Number(prices[incentive.token]);
                    if (prices[incentive.token] == null || isNaN(price)) { unpriced.add(incentive.token); price = 0; }
                    var possibleAmount = 0; // amount of incentive available if 25m vlCVX voted for gauges with maxPerVote
                    var rawAmount = BigInt(incentive.amount);
                    var rawMaxPerVote = BigInt(incentive.maxPerVote);
                    // convert amounts to human readable format
                    incentive.amount = ethers.formatUnits(incentive.amount, incentive.decimals);
                    incentive.maxPerVote = ethers.formatUnits(incentive.maxPerVote, incentive.decimals);

                    // a deposit's excluded voters earn nothing from it (rounds 104-105 had such deposits;
                    // reconcile no longer accepts them), so they come out of its earning votes
                    var depositEarning = earning;
                    if (Array.isArray(incentive.excluded) && incentive.excluded.length > 0) {
                        var excludedVotes = 0;
                        for (var x of incentive.excluded) { excludedVotes += votesLower[String(x).toLowerCase()] || 0; }
                        depositEarning = Math.max(0, earning - excludedVotes);
                    }

                    // check if entire incentive is consumed, or if there is a maxPerVote
                    if (incentive.maxPerVote != 0) {
                        // a capped deposit pays at most maxPerVote per earning vote (total rounded
                        // up, as reconcile submits it); the rest rolls over to the next round
                        var cap = rawMaxPerVote * BigInt(Math.ceil(depositEarning));
                        incentive.consumedAmount = ethers.formatUnits(cap < rawAmount ? cap : rawAmount, incentive.decimals);
                        // possible total USD available is based on 25m vlCVX voting for gauges with maxPerVote
                        // check if maxPerVote*25m is greater than total amount
                        possibleAmount = incentive.maxPerVote * 25000000 > incentive.amount ? incentive.amount : incentive.maxPerVote * 25000000;
                        // increase possible totals
                        possibleGaugeUSD[gauge] += possibleAmount * price; 
                        possibleTotalUSD += possibleAmount * price;
                    } else {
                        // if there is no maxPerVote, entire reward is consumed, unless nobody earns
                        // there: endRound pays nothing on a gauge with no earning votes
                        incentive.consumedAmount = depositEarning > 0 ? incentive.amount : "0.0";
                        possibleAmount = incentive.amount; // readablity
                        // increase possible totals
                        possibleGaugeUSD[gauge] += incentive.amount * price;
                        possibleTotalUSD += incentive.amount * price;
                    }
                    var total = incentive.amount * price; // readablity
                    var consumed = incentive.consumedAmount * price;
                    
                    // increase totals
                    gaugeConsumedUSD[gauge] += consumed;
                    gaugeUSD[gauge] += total;
                    totalConsumedUSD += consumed;
                    totalUSD += total;

                    displayObject[chain].gauges[name].rewards.push({
                        symbol: incentive.symbol,
                        consumedAmount: incentive.consumedAmount,
                        amount: incentive.amount,
                        maxPerVote: incentive.maxPerVote,
                        totalUSD: total,
                        consumedUSD: consumed,
                        possibleTotalUSD: possibleAmount * price,
                    });
                }
                var per;
                if(earning == 0) {
                    per = 0;
                } else {
                    per = gaugeConsumedUSD[gauge] / earning;
                    pervls.push(per);
                }
                displayObject[chain].gauges[name].totals = {
                    consumedUSD: gaugeConsumedUSD[gauge],
                    totalUSD: gaugeUSD[gauge],
                    possibleTotalUSD: possibleGaugeUSD[gauge],
                    perVlCVX: per
                }
            }

            if(pervls.length == 0) { // to view table before votes come in
                pervls.push(0);
            }
            
            displayObject[chain].totals = {
                votes : totalVotes,
                consumedUSD: totalConsumedUSD,
                totalUSD: totalUSD,
                possibleTotalUSD: possibleTotalUSD,
                earningVotes: totalEarning,
                perVlCVX: totalEarning > 0 ? totalConsumedUSD / totalEarning : 0,
                perVlCVXMedian: pervls.sort((a, b) => a - b)[Math.floor(pervls.length/2)]
            }
        }
        if (unpriced.size > 0) {
            console.log(unpriced.size + " token(s) without a USD price, counted as $0: " + [...unpriced].join(", "));
        }
        return displayObject;
    }
};

return api;
};
