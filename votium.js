// votium.js: Votium deposits, rounds, gauges and vote tallies for vlCVX (Curve, f(x)) and veYB.
//
//   const votium = require('votium.js')({
//       providers: { mainnet: process.env.RPC_URL },
//       storage: require('votium.js/storage/local')('./storage'),
//   });
//
// Options:
//   providers   RPC URLs by network: mainnet (required), zkevm, optimism, arbitrum
//   storage     { read(key, suffix), write(key, value, suffix) }: storage/local.js, storage/firebase.js,
//               or your own
//   cvx         a cvxonchain instance (built from providers.mainnet if left out)
//   logBlocksLimit  max blocks per log query, default 10000 (Infura's limit)
//   l2votePlatform, delegationRegistry, vlCVXLocker   legacy contract overrides
// Nothing is read and no RPC is made until a function is called.

// local json files
const deployments = require('./deployments.json');
const depositAbi = require('./abis/votium.json');
const depositVlcvxFXNAbi = require('./abis/votiumVlCVXFXN.json');
const depositVeYBAbi = require('./abis/votiumVeYB.json');
const erc20Abi = require('./abis/erc20.json');
const l2Abi = require('./abis/l2platform.json');
const lockerAbi = require('./abis/locker.json');
const delegationAbi = require('./abis/delegation.json');


// outside libraries
const { ethers } = require('ethers');
const EthDater = require('ethereum-block-by-date');
const { MerkleTree } = require('merkletreejs')
const keccak256 = require('keccak256')
// multicall call builders (ethers-multicall's API, on ethers 6 and Multicall3), archive block tags included
const { Contract, Provider } = require('./multicall.js');
const fetch = require('node-fetch');

// Snapshot vote tallying: rounds before on-chain voting (history only)
const createSnap = require('./snap.js');

// on-chain vote tallying for Curve and f(x)
const createOnchainVotes = require('./onchainVotes.js');

// Votium's opt-out registries (Curve, f(x))
const createOptOuts = require('./optOuts.js');

// chain ids of the networks votium.js knows, so their providers never ask the RPC for one
const CHAIN_IDS = { mainnet: 1, optimism: 10, arbitrum: 42161, zkevm: 1101 };

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
    l2votePlatform: "0x6d024fa49de64a975980cddd4c3212492d189e57",
    delegationRegistry: "0x469788fE6E9E9681C6ebF3bF78e7Fd26Fc015446",
    vlCVXLocker: "0x72a19342e8F1838460eBFCCEf09F6585e32db86E",
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

// Working variables the functions below share. They used to be implicit globals, shared by every
// module in the process; now each instance has its own.
var i, j, k, n, r, g, w, v, gi, id, mProvider, vlCVXmLocker, infoRaw, info, poolName, active, endBlock,
    userIncentives, roundd, weight, addressArray, currentEpoch, latestIndex, epochIndex, _date,
    totalVlCVX, globalCheckList, totalDelegated, userlist, chain, call, formatted, blocktime, tree,
    Gauge, prices, priceString, shot, target_block, userBase, userAdjusted, userDelegation, eventsAll,
    decimals, symbols, gauge, incentivesRaw, user;

// declaring some variables used in multiple scopes

var dater; // eth-dater instance, not initialized until mainnet provider is initialized

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

var calls = {};
var providers = {};
var mProviders = {};
var contracts = [{},{},{},{}];
var mContracts = [{},{},{},{}];
var l2platform;
var ml2platform;
var vlCVXLocker;
var delegationRegistry;
var querySize = 1000;
var round = [];
round[0] = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 14)) - 1348;
round[2] = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 14)) - 1413;
round[3] = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 7)) - 2910;
var Gauges = []; // per platform, loaded from storage on first use (_loadGauges)

var vlCVXAddresses = {}; // legacy vlCVX address list, rebuilt by _getVlCVXAddresses

function roundEpoch(_round, p) { 
    if(p==2) return (_round+1413) * 86400 * 14;
    if(p==0) return (_round+1348) * 86400 * 14; 
    if(p==3) return (_round+2910) * 86400 * 7;
    return null;
}
for(i in round) {
    if(i != 3) {
        if(Math.floor(Date.now()/1000)-roundEpoch(round[i], i) > 60*60*24*5) round[i]++; // if vote is over, default to next round
    }
}

// Initialize providers and votium deposit contracts (single and multicall)

for (i in config.providers) {
    // skip if provider is not defined
    if (config.providers[i] == "") continue;
    try {
        // single and multicall uses separate providers and contract instances
        // a fixed network: no chain id lookups, and no endless startup retries when an RPC is down
        providers[i] = CHAIN_IDS[i]
            ? new ethers.JsonRpcProvider(config.providers[i], CHAIN_IDS[i], { staticNetwork: true })
            : new ethers.JsonRpcProvider(config.providers[i]);
        mProviders[i] = new Provider(providers[i]);
        if(i == "zkevm" && config.l2votePlatform != undefined) {
            l2platform = new ethers.Contract(config.l2votePlatform, l2Abi, providers[i]);
            ml2platform = new Contract(config.l2votePlatform, l2Abi);
        } else if(i == "mainnet") {
            mProvider = new Provider(providers[i]);
            dater = new EthDater(providers[i]);
            vlCVXLocker = new ethers.Contract(config.vlCVXLocker, lockerAbi, providers[i]);
            vlCVXmLocker = new Contract(config.vlCVXLocker, lockerAbi); // read at an archive block
            delegationRegistry = new Contract(config.delegationRegistry, delegationAbi);
        }
        if(deployments.vlcvxCurveFrax[i] != "") {
            contracts[0][i] = new ethers.Contract(deployments.vlcvxCurveFrax[i], depositAbi, providers[i]);
            mContracts[0][i] = new Contract(deployments.vlcvxCurveFrax[i], depositAbi);
        }
        
        if(deployments.vlcvxFXN[i] != "") {
            contracts[2][i]  = new ethers.Contract(deployments.vlcvxFXN[i], depositVlcvxFXNAbi, providers[i]);
            mContracts[2][i]  = new Contract(deployments.vlcvxFXN[i], depositVlcvxFXNAbi);
        }

        if(deployments.veYB[i] != "") {
            contracts[3][i]  = new ethers.Contract(deployments.veYB[i], depositVeYBAbi, providers[i]);
            mContracts[3][i]  = new Contract(deployments.veYB[i], depositVeYBAbi);
        }
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not connect to " + i);
    }
}

function bufToHex(buffer) { // buffer is an ArrayBuffer
    return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('')
}

async function _getTokenInfoFromIncentives(network, incentivesRaw) {

    // get decimals for each token, this will make it easier to display amounts correctly in frontend
    var decimals = {};
    var symbols = {};
    var tokenContracts = {};

    calls[network] = [];
    for(i in incentivesRaw) {
        // only add decimals call if we haven't already
        if(decimals[incentivesRaw[i].token] == undefined) {
            // initialize token contract if we haven't already
            tokenContracts[incentivesRaw[i].token] = new Contract(incentivesRaw[i].token, erc20Abi);
            decimals[incentivesRaw[i].token] = 0; // placeholder so we don't call decimals more than once
            calls[network].push(tokenContracts[incentivesRaw[i].token].decimals());
            calls[network].push(tokenContracts[incentivesRaw[i].token].symbol());
        }
    }
    try {
        // unmapped decimals
        infoRaw = await mProviders[network].all(calls[network]);
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get token info for " + network);
        return null;
    }
    // reset decimals array so we can map in the same order we built
    decimals = {};
    n = 0; // map counter
    for(i in incentivesRaw) {
        // only map decimals if we haven't already (same order as calls)
        if(decimals[incentivesRaw[i].token] == undefined) {
            decimals[incentivesRaw[i].token] = infoRaw[n];
            n++;
            symbols[incentivesRaw[i].token] = infoRaw[n];
            n++;
        }
    }
    info = {decimals: decimals, symbols: symbols};
    return info;
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
    return Gauges[platform] || { gauges: {} };
}

// vlCVX withheld by the opt-out registries, per gauge, at the round's proposal epoch.
// Curve and f(x) only; empty before the registries existed or before the proposal does.
async function _withheld(_round, platform, gauges) {
    var name = VOTE_PLATFORMS[platform];
    if (name == null || gauges.length == 0) { return {}; }
    var proposalId = Math.floor((Math.floor((roundEpoch(_round, platform) - 1646265600) / (86400 * 7)) - 230) / 2);
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

    // build incentives object
    var n = 0; // map counter
    // building in the same way as we built the calls for incentivesRaw
    for (var i = 0; i < gauges.length; i++) {
        incentives[gauges[i]] = []; // initialize gauge incentive array

        var gpa = "0x0";
        for(var fg in gaugeList.gauges) {
            if(fg.toUpperCase() == gauges[i].toUpperCase()) {
                gpa = fg;
            }
        }
        
        if(gaugeList.gauges[gpa] == undefined) {
            poolName = "Unknown (" + gauges[i].substr(0,6) + "...)";
            active = false;
        } else {
            poolName = gaugeList.gauges[gpa].shortName;
            active = gaugeList.gauges[gpa].active;
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
            // if _round is earlier than current round, include additional data
            if(_round < round) {
                incentives[gauges[i]][j].distributed = incentivesRaw[n].distributed.toString();
                incentives[gauges[i]][j].recycled = incentivesRaw[n].recycled.toString();
            }
            n++;
        }
    }

    return incentives;
}

// get incentives for a specified network and depositor
async function _getIncentivesByUser(network, user, platform=0) {
    // initialize providers and contracts
    await mProviders[network].init()
    var pointer = gaugeKey(platform);

    Gauges[platform] = await storage.read(pointer);
    var gaugeList = Gauges[platform];

    if (!contracts[platform][network]) return null;
    

    var currentBlock = await providers[network].getBlockNumber();
    var startBlock = currentBlock-200000; // deployment block


    // get all incentives where _depositor == user
    // batch in 100000 block increments
    var eventsAll = [];
    // non-overlapping windows of logBlocksLimit blocks (from and to both inclusive): RPCs cap the
    // block range of a log query (Infura: 10,000), and v1's [start, start + 100000] windows, which
    // also reused endBlock as the next start (reading the boundary block twice), were rejected
    while(startBlock <= currentBlock){
        endBlock = startBlock + config.logBlocksLimit - 1;
        if(endBlock > currentBlock){
            endBlock = currentBlock;
        }
        //console.log("getting incentives from " + startBlock + " to " + endBlock);
        eventsAll.push(contracts[platform][network].queryFilter(contracts[platform][network].filters.NewIncentive(null, null, null, null, null, null, null, user),startBlock,endBlock));
        startBlock = endBlock + 1;
    }
    eventsAll = await Promise.all(eventsAll);
    var events = [];
    for(var i=0; i < eventsAll.length; i++){
        events = events.concat(eventsAll[i]);
    }
    userIncentives = {};
    for(i in events) {
        roundd = events[i].args._round.toString();
        gauge = events[i].args._gauge;
        id = events[i].args._index.toString();
        if(userIncentives[roundd] == undefined) userIncentives[roundd] = {};
        if(userIncentives[roundd][gauge] == undefined) userIncentives[roundd][gauge] = [];
        userIncentives[roundd][gauge].push(id);
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
        console.log("Could not get incentives for " + network + " round " + _round + " gauge " + gauges[i] + " incentive " + j);
        return null;
    }

    info = await _getTokenInfoFromIncentives(network, incentivesRaw);
    decimals = info.decimals;

    // build incentives object
    var n = 0; // map counter
    // building in the same way as we built the calls for incentivesRaw
    for(r in userIncentives) {
        for(g in userIncentives[r]) {
            for(i in userIncentives[r][g]) {
                if(gaugeList.gauges[g] == undefined) {
                    console.log("\n\n!!!!!!!!!!!!!!\n\nUnknown gauge: " + g);
                    delete userIncentives[r][g][i];
                    continue
                }
                userIncentives[r][g][i] = {
                    "index": userIncentives[r][g][i],
                    "pool": gaugeList.gauges[g].shortName,
                    "token": incentivesRaw[n].token,
                    "decimals": decimals[incentivesRaw[n].token],
                    "amount": incentivesRaw[n].amount.toString(),
                    "maxPerVote": incentivesRaw[n].maxPerVote.toString(),
                    "excluded": incentivesRaw[n].excluded
                };
                // if _round is earlier than current round, include additional data
                if(r < round) {
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
    var pointer = gaugeKey(platform);

    Gauges[platform] = await storage.read(pointer);

    if (Gauges[platform] == undefined) { Gauges[platform] = {}; }
    if (Gauges[platform].lastUpdated == undefined) { Gauges[platform].lastUpdated = 0; }
    // v1 stored the hardcoded YB list with a far-future date so it never refreshed
    if (Gauges[platform].lastUpdated > Math.floor(Date.now() / 1000)) { Gauges[platform].lastUpdated = 0; }
    if (Math.floor(Date.now() / 1000) - Gauges[platform].lastUpdated < 60 * 60 * 8) { return; }

    // build Gauges[platform] object
    Gauges[platform] = { lastUpdated: Math.floor(Date.now() / 1000), gauges: {}};

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
            Gauges[platform].gauges[ybGauge] = {
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
                Gauges[platform].gauges[gaugeAddress] = {
                    "shortName": GaugesRaw[i].shortName,
                    "active": (GaugesRaw[i].hasNoCrv == false && GaugesRaw[i].is_killed == false),
                }
                if(Gauges[platform].gauges[gaugeAddress].active == false) {
                    delete Gauges[platform].gauges[gaugeAddress];
                }
            }
            if(Gauges[platform].gauges["0xbaf05d7aa4129ca14ec45cc9d4103a9ab9a9ff60"] == undefined) {
                Gauges[platform].gauges["0xbaf05d7aa4129ca14ec45cc9d4103a9ab9a9ff60"] = {
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
            Gauges[platform] = {gauges: gauge, lastUpdated: Math.floor(Date.now() / 1000)};
        }
    }
    // save gauges to storage
    await storage.write(pointer, Gauges[platform]);
}

async function _l2round2proposal(_round) {
    // initialize providers and contracts
    await mProviders["zkevm"].init()
    // map round to proposal
    var proposalBase = _round - 48; // starting point to match with l2 deployment
    var proposals;
    var proposal = {};

    // since proposals can be replaced with new merkle data, 
    // we need to check for the newest proposal with the correct 
    // start and end times to match the round

    // get proposal count
    var proposalCount = await l2platform.proposalCount();
    if(proposalBase > proposalCount) return null; // return null if round is too high

    // get proposal data from base proposal number to newest, to select the newest within the time range
    calls["zkevm"] = [];
    // don't go past proposal count
    for(var i = proposalBase; i < proposalCount; i++) {
        calls["zkevm"].push(ml2platform.proposals(i));
    }
    try {
        proposals = await mProviders["zkevm"].all(calls["zkevm"]);
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get L2 proposals for " + _round);
        return null;
    }
    // find newest proposal within time range
    for(i in proposals) {
        if(proposals[i].startTime >= roundEpoch(_round) && proposals[i].startTime <= roundEpoch(_round)+60*60*24) {
            // overwrite proposal if newer proposal is within time range
            proposal = {
                "id": proposalBase+Number(i),
                "baseWeightMerkleRoot": proposals[i].baseWeightMerkleRoot,
                "startTime": Number(proposals[i].startTime),
                "endTime": Number(proposals[i].endTime)
            }
        } else if(proposals[i].startTime > roundEpoch(_round)+60*60*24) {
            // break if proposal is outside of time range
            break;
        }
    }
    if(proposal.id == undefined) return null; // return null if we failed to find a proposal within time range
    return proposal;
}

async function _l2votesFull(_round) {
    // initialize providers and contracts
    await mProviders["zkevm"].init()
    var proposal = await _l2round2proposal(_round);
    if(proposal == null) return null; // return null if no proposal
    var voters;
    var votes = {};

    // get voter count
    var voterCount = await l2platform.getVoterCount(proposal.id);
    if(voterCount == 0) return null; // return null if no voters
    
    // get list of voters
    calls["zkevm"] = [];
    for(var i = 0; i < voterCount; i++) {
        calls["zkevm"].push(ml2platform.votedUsers(proposal.id, i));
    }
    try {
        voters = await mProviders["zkevm"].all(calls["zkevm"]);
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get L2 voters for proposal " + proposal.id);
        return null;
    }

    // get votes for each voter
    calls["zkevm"] = [];
    for(i in voters) {
        calls["zkevm"].push(ml2platform.getVote(proposal.id, voters[i]));
    }
    try {
        // map votes to voter based on call order
        var votesRaw = await mProviders["zkevm"].all(calls["zkevm"]);
        var n = 0; // map counter
        for(i in voters) {
            votes[voters[i]] = votesRaw[n];
            n++;
        }
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get L2 votes for proposal " + proposal.id);
        return null;
    }

    // break down into gauge -> voter -> vlCVX
    var voteData = {total:0,gauges:{}};
    for(v in votes) { // v = voter address
        // cycle through gauges included in vote
        for(gi in votes[v].gauges) { // gi = gauge index
            g = votes[v].gauges[gi]; // g = gauge address
            // if we have no data for this gauge, initialize
            if(voteData.gauges[g] == undefined) voteData.gauges[g] = {total:0, voters:{}};
            // user weight deliniated by 10000 in contract
            weight = Number(votes[v].weights[gi]);
            // get user amount in vlCVX (baseWeight + adjustedWeight)
            var userAmount = Number(ethers.formatUnits(votes[v].baseWeight, 18));
            userAmount += Number(ethers.formatUnits(votes[v].adjustedWeight, 18));
            // convert to amout for gauge weight assigned
            var toGauge = userAmount * weight / 10000;
            // add to total, gauge total, and assign to gauge voter amount
            voteData.total += toGauge;
            voteData.gauges[g].total += toGauge;
            voteData.gauges[g].voters[v] = toGauge;
        }
    }
    // save to storage
    await storage.write("l2voteData", voteData, _round);
    return voteData;
}

async function _getVlCVXAddresses(target_block, fullsync=false) {
    
    // 14320609 is deployment block
    if(vlCVXAddresses.lastBlock == undefined) { vlCVXAddresses = {lastBlock:14320609, userBase:{}, userDelegation: {}, userAdjusted: {}}; }
    // get all staked events in batches of 100000 blocks
    var stakedEvents = [];
    if(fullsync) { vlCVXAddresses.lastBlock = 14320609; vlCVXAddresses.userBase = {}; vlCVXAddresses.userDelegation = {}; vlCVXAddresses.userAdjusted = {}; }
    var startBlock = vlCVXAddresses.lastBlock-1;
    eventsAll = [];
    while(startBlock < target_block){
        endBlock = startBlock + 100000;
        if(endBlock > target_block){
            endBlock = target_block;
        }
        //console.log("getting lock events from " + startBlock + " to " + endBlock);
        eventsAll.push(vlCVXLocker.queryFilter(vlCVXLocker.filters.Staked(),startBlock,endBlock));
        startBlock = endBlock;
    }
    eventsAll = await Promise.all(eventsAll);
    for(var i=0; i < eventsAll.length; i++){
        stakedEvents = stakedEvents.concat(eventsAll[i]);
    }
    for(var i=0; i < stakedEvents.length; i++){
        var user = ethers.getAddress(stakedEvents[i].args._user);
        if(vlCVXAddresses.userBase[user] == undefined){
            vlCVXAddresses.userBase[user] = 0;
        }
    }
    //console.log("Total locker addresses: "+Object.keys(vlCVXAddresses.userBase).length);
    vlCVXAddresses.lastBlock = target_block;

    addressArray = Object.keys(vlCVXAddresses.userBase);
    var groups = Math.floor(Number( (addressArray.length/querySize) + 1));
    let rm = 0;
    await Promise.all([...Array(Number(groups)).keys()].map(async i => {
        var start = i*querySize;
        var finish = i*querySize + querySize - 1;
        if(finish >= addressArray.length){
            finish = addressArray.length - 1;
        }
        //console.log("Checking lockedBalanceOf from " + start + " to " +finish);
        var calldata = [];
        var addresses = [];
        for(var c = start; c <= finish; c++){
            calldata.push(vlCVXmLocker.lockedBalanceOf(addressArray[c]));
            addresses.push(addressArray[c]);
        }
        //console.log(calldata);
        let balData = await mProvider.all(calldata, target_block);
        for(var d = 0; d < balData.length; d++){
            // if(balData[d] == "0x")continue;
            // console.log("baldata[d]: " +balData[d]);
            var bal = BigInt(balData[d]);
            if(bal.toString() == "0") {
                delete vlCVXAddresses.userBase[ethers.getAddress(addresses[d])];
                rm++;
            }
        }
    }));
    // write to storage
    await storage.write("vlCVXAddresses", vlCVXAddresses);
    return vlCVXAddresses;
}

async function _getLockedBalances(target_block) {
    currentEpoch = Math.floor(Date.now()/1000/(86400*7))*86400*7; // cvx epoch is 7 days
    latestIndex = await vlCVXLocker.epochCount();
    latestIndex = Number(latestIndex)-1;
    epochIndex = latestIndex;
    _date = currentEpoch;
    while(_date >= currentEpoch){
        _date = await vlCVXLocker.epochs(epochIndex);
        _date = Number(_date.date);
        if(_date >= currentEpoch){
            epochIndex--;
        }
    }
    currentEpoch = latestIndex>epochIndex ? epochIndex+1 : epochIndex;
    //console.log("current epoch: "+currentEpoch);

    addressArray = Object.keys(vlCVXAddresses.userBase);
    var groups = Math.floor(Number( (addressArray.length/querySize) + 1));

    totalVlCVX = 0;
    await Promise.all([...Array(Number(groups)).keys()].map(async i => {
        var start = i*querySize;
        var finish = i*querySize + querySize - 1;
        if(finish >= addressArray.length){
            finish = addressArray.length - 1;
        }
        //console.log("get balances from " + start + " to " +finish);
        var calldata = [];
        var addresses = [];
        for(var c = start; c <= finish; c++){
            calldata.push(vlCVXmLocker.balanceAtEpochOf(currentEpoch, addressArray[c]));
            addresses.push(addressArray[c]);
        }
        //console.log(calldata);
        let balData = await mProvider.all(calldata, target_block);
        for(var d = 0; d < balData.length; d++){
            // if(balData[d] == "0x")continue;
            // console.log("baldata[d]: " +balData[d]);
            var bal = BigInt(balData[d]);
            vlCVXAddresses.userBase[ethers.getAddress(addresses[d])] = bal.toString();
            totalVlCVX += Number(ethers.formatUnits(bal,18));
        }
    }));

    //console.log("Total vlCVX: "+totalVlCVX);
    // write to storage
    await storage.write("vlCVXAddresses", vlCVXAddresses);
    //console.log("Balances cache updated");
    return vlCVXAddresses.userBase;
}

async function _getDelegations(target_block) {
    return false; // Make sure old contract isn't being used anywhere

    addressArray = Object.keys(vlCVXAddresses.userBase);
    var groups = Math.floor(Number( (addressArray.length/querySize) + 1));
    globalCheckList = [];
    await Promise.all([...Array(Number(groups)).keys()].map(async i => {
        var start = i*querySize;
        var finish = i*querySize + querySize - 1;
        if(finish >= addressArray.length){
            finish = addressArray.length - 1;
        }
        //console.log("get cvx delegations from " + start + " to " +finish);
        var calldata = [];
        var addresses = [];
        for(var c = start; c <= finish; c++){
            calldata.push(delegationRegistry.delegation(addressArray[c], "0x6376782e65746800000000000000000000000000000000000000000000000000"));
            addresses.push(addressArray[c]);
        }
        //console.log(calldata);
        let delData = await mProvider.all(calldata, target_block);
        for(var d = 0; d < delData.length; d++){
            if(delData[d] == ethers.ZeroAddress) {
                globalCheckList.push(addresses[d]);
            } else {
                vlCVXAddresses.userDelegation[ethers.getAddress(addresses[d])] = ethers.getAddress(delData[d]);
            }
        }
    }));
    addressArray = globalCheckList;
    var groups = Math.floor(Number( (addressArray.length/querySize) + 1));
    await Promise.all([...Array(Number(groups)).keys()].map(async i => {
        var start = i*querySize;
        var finish = i*querySize + querySize - 1;
        if(finish >= addressArray.length){
            finish = addressArray.length - 1;
        }
        //console.log("get global delegations from " + start + " to " +finish);
        var calldata = [];
        var addresses = [];
        for(var c = start; c <= finish; c++){
            calldata.push(delegationRegistry.delegation(addressArray[c], "0x0000000000000000000000000000000000000000000000000000000000000000"));
            addresses.push(addressArray[c]);
        }
        //console.log(calldata);
        let delData = await mProvider.all(calldata, target_block);
        for(var d = 0; d < delData.length; d++){

            var delegate = ethers.getAddress(delData[d]);
            if(delegate != ethers.ZeroAddress) {
                vlCVXAddresses.userDelegation[addresses[d]] = delegate;
            } else {
                vlCVXAddresses.userDelegation[addresses[d]] = addresses[d];
            }
        }
    }));
    // write to storage
    await storage.write("vlCVXAddresses", vlCVXAddresses);
    //console.log("Delegations cache updated");
}

async function _parseAddressDelegation () {
    userAdjusted = {};
    for(user in vlCVXAddresses.userBase) {
        if(vlCVXAddresses.userDelegation[user] == undefined) {
            vlCVXAddresses.userDelegation[user] = user;
        }
        if(user.toString().toLowerCase() == "undefined") {
            console.error("undefined user" + user);
        }
        if(userAdjusted[user] == undefined) {
            userAdjusted[user] = 0n;
        }
        if(userAdjusted[vlCVXAddresses.userDelegation[user]] == undefined) {
            userAdjusted[vlCVXAddresses.userDelegation[user]] = 0n;
        }
        if(vlCVXAddresses.userDelegation[vlCVXAddresses.userDelegation[user]] == undefined) {
            vlCVXAddresses.userDelegation[vlCVXAddresses.userDelegation[user]] = vlCVXAddresses.userDelegation[user];
        }
        if(vlCVXAddresses.userBase[vlCVXAddresses.userDelegation[user]] == undefined) {
            vlCVXAddresses.userBase[vlCVXAddresses.userDelegation[user]] = 0;
        }
        if(vlCVXAddresses.userDelegation[user] != user) {
            userAdjusted[vlCVXAddresses.userDelegation[user]] = userAdjusted[vlCVXAddresses.userDelegation[user]] + BigInt(vlCVXAddresses.userBase[user]);
        }
    }
    totalDelegated = 0n;
    for(user in userAdjusted) {
        totalDelegated = totalDelegated + userAdjusted[user];
        userAdjusted[user] = userAdjusted[user].toString();
    }
    //console.log("Total delegated: "+ethers.formatUnits(totalDelegated,18));
    vlCVXAddresses.userAdjusted = userAdjusted;
    // write to storage
    await storage.write("vlCVXAddresses", vlCVXAddresses);
    //console.log("Cleaned up cache");
    return [vlCVXAddresses.userBase, vlCVXAddresses.userAdjusted, vlCVXAddresses.userDelegation];
}

async function _vlCVXTree(userBase, userAdjusted, userDelegation, target_block) {
    var elements = [];
    // sort userBase object by key
    userBase = Object.keys(userBase).sort().reduce((r, k) => (r[k] = userBase[k], r), {});
    userlist = Object.keys(userBase);
    for(user in userBase){
        // abi encode packed user, delegate, base amount, adjustment
        //console.log("adding "+user+" to tree")
        elements.push(ethers.solidityPackedKeccak256(["address","address","uint256","int256"],[user,userDelegation[user],BigInt(userBase[user]),BigInt(userAdjusted[user])]));
    }

    const merkleTree = new MerkleTree(elements, keccak256, { sortPairs: true })
    const root = merkleTree.getRoot()

    var compiledProofs = {root: "0x"+bufToHex(root),blockHeight:target_block,users:{}};
    for(var i=0; i < elements.length; i++){
        var proofbytes = merkleTree.getProof(elements[i]);
        var proofHex = proofbytes.map(e => "0x"+e.data.toString('hex'));
        var address = userlist[i];
        var delegate = userDelegation[userlist[i]];
        var baseamount = userBase[userlist[i]];
        var adjustedamount = userAdjusted[userlist[i]];

        if(!merkleTree.verify(proofbytes,elements[i],root)) {
            //console.error("proof verification failed at index " + i);
        }

        if(compiledProofs.users[address] != undefined){
            //console.error("address already exists");
        }
        
        compiledProofs.users[address] = {};
        compiledProofs.users[address]["leaf"] = elements[i].toString('hex');
        compiledProofs.users[address]["proof"] = proofHex;
        compiledProofs.users[address]["base_amount"] = baseamount;
        compiledProofs.users[address]["adjusted_amount"] = adjustedamount;
        compiledProofs.users[address]["delegate"] = delegate;

    }
    // write to storage
    await storage.write("vlCVXMerkles", compiledProofs, round);
    //console.log("Merkle tree written to file "+epochString+".json");
    return compiledProofs;
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
        roundd = this.round(platform);
        return await this.getIncentivesByRound(roundd + roundOffset, platform);
    },
    // get incentives for a given round
    getIncentivesByRound: async function (_round = 0, platform=0) {
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
    // update snapshot for a given round, using an optional delay from last call
    // can pass your own voter address to be excluded, to assist in
    // calculating a new vote for that address (while snapshot is active)
    updateSnapshot: async function (_round = 0, delay = 0, platform=0, voter=null) {
        if(platform == 3) {
            return null;
        }
        noPrisma(platform);
        if(_round == 0) _round = this.round(platform);
        // Curve (0) and f(x) (2) vote on-chain. Past rounds come from storage, including the
        // Snapshot-era ones (Curve before round 128, f(x) before round 63).
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
    // get l2 votes for a given round, in the same format as snapshot function
    l2votes: async function (_round = 0, platform=0) {
        if(_round == 0) _round = this.round(platform);
        return await _l2votesFull(_round, platform);
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
    // get all incentive ids for a given user
    getIncentivesByUser: async function (user, platform=0) {
        noPrisma(platform);
        var promises = [];
        for (i in contracts[platform]) {
            promises.push(_getIncentivesByUser(i, user, platform));
        }
        var results = await Promise.all(promises);
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
        // save to storage
        await storage.write(USER_DEPOSIT_KEYS[platform], incentives, user.toLowerCase());
        
        return incentives;
    },
    generateVlCVXMerkle: async function (fullsyncAddresses=false) {
        return false; // Make sure old contract isn't being used anywhere
        const newEpoch = Math.floor(Date.now()/1000/(86400*7))*86400*7; // cvx epoch is 7 days
        target_block = await dater.getDate(newEpoch*1000, true, false);
        target_block = target_block.block;
        blocktime = await providers["mainnet"].getBlock(target_block);
        while(blocktime.timestamp < newEpoch) {
            target_block += 1;
            blocktime = await providers["mainnet"].getBlock(target_block);
        }

        // check if console argument is "--sync"
        if (fullsyncAddresses) {
            vlCVXAddresses = await _getVlCVXAddresses(target_block, true);
        } else {
            vlCVXAddresses = await _getVlCVXAddresses(target_block)
        }
        await _getLockedBalances(target_block);
        await _getDelegations(target_block);
        [userBase, userAdjusted, userDelegation] = await _parseAddressDelegation();
        tree = await _vlCVXTree(userBase, userAdjusted, userDelegation, target_block);
    },
    // combine several functions to return a full round object
    roundObject : async function (_round = 0, platform=0) {
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

        Gauge = Gauges[platform].gauges;
        
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
        // cycle through different supported networks
        for (chain in incentives) {
            var totalVotes = 0; // total votes for all gauges
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
                displayObject[chain].gauges[Gauge[gauge].shortName] = {};
                displayObject[chain].gauges[Gauge[gauge].shortName].votes = vote.total;
                displayObject[chain].gauges[Gauge[gauge].shortName].earningVotes = earning;
                displayObject[chain].gauges[Gauge[gauge].shortName].rewards = [];
                totalVotes += vote.total;
                //console.log("   Votes for gauge: " + vote.total);
                //console.log("   Rewards for gauge:");
                for (i in incentives[chain][gauge]) {
                    var incentive = incentives[chain][gauge][i]; // for code readability
                    var possibleAmount = 0; // amount of incentive available if 25m vlCVX voted for gauges with maxPerVote
                    var rawAmount = BigInt(incentive.amount);
                    var rawMaxPerVote = BigInt(incentive.maxPerVote);
                    // convert amounts to human readable format
                    incentive.amount = ethers.formatUnits(incentive.amount, incentive.decimals);
                    incentive.maxPerVote = ethers.formatUnits(incentive.maxPerVote, incentive.decimals);

                    // check if entire incentive is consumed, or if there is a maxPerVote
                    if (incentive.maxPerVote != 0) {
                        // a capped deposit pays at most maxPerVote per earning vote (total rounded
                        // up, as reconcile submits it); the rest rolls over to the next round
                        var cap = rawMaxPerVote * BigInt(Math.ceil(earning));
                        incentive.consumedAmount = ethers.formatUnits(cap < rawAmount ? cap : rawAmount, incentive.decimals);
                        // possible total USD available is based on 25m vlCVX voting for gauges with maxPerVote
                        // check if maxPerVote*25m is greater than total amount
                        possibleAmount = incentive.maxPerVote * 25000000 > incentive.amount ? incentive.amount : incentive.maxPerVote * 25000000;
                        // increase possible totals
                        possibleGaugeUSD[gauge] += possibleAmount * prices[incentive.token]; 
                        possibleTotalUSD += possibleAmount * prices[incentive.token];
                    } else {
                        // if there is no maxPerVote, entire reward is consumed, unless nobody earns
                        // there: endRound pays nothing on a gauge with no earning votes
                        incentive.consumedAmount = earning > 0 ? incentive.amount : "0.0";
                        possibleAmount = incentive.amount; // readablity
                        // increase possible totals
                        possibleGaugeUSD[gauge] += incentive.amount * prices[incentive.token];
                        possibleTotalUSD += incentive.amount * prices[incentive.token];
                    }
                    var total = incentive.amount * prices[incentive.token]; // readablity
                    var consumed = incentive.consumedAmount * prices[incentive.token];
                    
                    // increase totals
                    gaugeConsumedUSD[gauge] += consumed;
                    gaugeUSD[gauge] += total;
                    totalConsumedUSD += consumed;
                    totalUSD += total;

                    displayObject[chain].gauges[Gauge[gauge].shortName].rewards.push({
                        symbol: incentive.symbol,
                        consumedAmount: incentive.consumedAmount,
                        amount: incentive.amount,
                        maxPerVote: incentive.maxPerVote,
                        totalUSD: total,
                        consumedUSD: consumed,
                        possibleTotalUSD: possibleAmount * prices[incentive.token],
                    });
                }
                var per;
                if(earning == 0) {
                    per = 0;
                } else {
                    per = gaugeConsumedUSD[gauge] / earning;
                    pervls.push(per);
                }
                displayObject[chain].gauges[Gauge[gauge].shortName].totals = {
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
                perVlCVX: totalConsumedUSD / totalVotes,
                perVlCVXMedian: pervls.sort((a, b) => a - b)[Math.floor(pervls.length/2)]
            }
        }
        return displayObject;
    }
};

return api;
};
