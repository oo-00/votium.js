// storage handler
const storage = require('./storageHandler.js');
// local json files
const config = require('./.config.json');
const deployments = require('./deployments.json');
const depositAbi = require('./abis/votium.json');
const erc20Abi = require('./abis/erc20.json');
const l2Abi = require('./abis/l2platform.json');

// outside libraries
const { ethers } = require('ethers');
const { setMulticallAddress, Contract, Provider } = require('ethers-multicall');
setMulticallAddress(10, "0x7Cbc68dc836e05833CF88b6676715dB805B5c0a2");
setMulticallAddress(1101, "0xcA11bde05977b3631167028862bE2a173976CA11");

const fetch = require('node-fetch');


// temporary snapshot vote tallying
const snap = require('./snap.js');


var curveGauges = storage.read("gauges"); // curve gauges

var coingecko = "https://api.coingecko.com/api/v3/simple/token_price/ethereum?vs_currencies=usd&contract_addresses=";
const curveGaugeEndpoint = "https://api.curve.fi/api/getAllGauges";

// declaring some variables used in multiple scopes
var calls = {};
var providers = {};
var mProviders = {};
var contracts = {};
var mContracts = {};
var l2platform;
var ml2platform;

var round = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 14)) - 1348;
function roundEpoch(_round) { return (_round+1348) * 86400 * 14; }

// Initialize providers and votium deposit contracts (single and multicall)
for (i in config.providers) {
    // skip if provider is not defined
    if (config.providers[i] == "") continue;
    try {
        // single and multicall uses separate providers and contract instances
        providers[i] = new ethers.providers.JsonRpcProvider(config.providers[i]);
        mProviders[i] = new Provider(providers[i]);
        if(i == "zkevm" && config.l2votePlatform != undefined) {
            l2platform = new ethers.Contract(config.l2votePlatform, l2Abi, providers[i]);
            ml2platform = new Contract(config.l2votePlatform, l2Abi);
        }
        if(deployments[i] == "") continue;
        contracts[i] = new ethers.Contract(deployments[i], depositAbi, providers[i]);
        mContracts[i] = new Contract(deployments[i], depositAbi);
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not connect to " + i);
    }
}

// get incentives for a specified network and round number
async function _getIncentives(network, _round) {
    // initialize providers and contracts
    await mProviders[network].init()
    if (!contracts[network]) return null;

    // declare arrays we will need
    var gauges = [];
    var incentives = {};
    var incentivesRaw = [];
    var incentivesLengths = [];
    // single call, since we're dealing with only 1 round
    var gaugesLength = await contracts[network].gaugesLength(_round); 

    // get gauges for round
    calls[network] = [];
    for (var i = 0; i < gaugesLength; i++) {
        calls[network].push(mContracts[network].roundGauges(_round, i));
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
        calls[network].push(mContracts[network].incentivesLength(_round, gauges[i]));
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
            calls[network].push(mContracts[network].viewIncentive(_round, gauges[i], j));
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

    // get decimals for each token, this will make it easier to display amounts correctly in frontend
    var decimals = {};
    var tokenContracts = {};

    calls[network] = [];
    for(i in incentivesRaw) {
        // only add decimals call if we haven't already
        if(decimals[incentivesRaw[i].token] == undefined) {
            // initialize token contract if we haven't already
            tokenContracts[incentivesRaw[i].token] = new Contract(incentivesRaw[i].token, erc20Abi);
            decimals[incentivesRaw[i].token] = 0; // placeholder so we don't call decimals more than once
            calls[network].push(tokenContracts[incentivesRaw[i].token].decimals());
        }
    }
    try {
        // unmapped decimals
        decimalsRaw = await mProviders[network].all(calls[network]);
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get decimals for " + network);
        return null;
    }
    // reset decimals array so we can map in the same order we built
    decimals = {};
    n = 0; // map counter
    for(i in incentivesRaw) {
        // only map decimals if we haven't already (same order as calls)
        if(decimals[incentivesRaw[i].token] == undefined) {
            decimals[incentivesRaw[i].token] = decimalsRaw[n];
            n++;
        }
    }

    // build incentives object
    var n = 0; // map counter
    // building in the same way as we built the calls for incentivesRaw
    for (var i = 0; i < gauges.length; i++) {
        incentives[gauges[i]] = []; // initialize gauge incentive array
        for (var j = 0; j < incentivesLengths[i]; j++) {
            incentives[gauges[i]][j] = {
                "index": j,
                "token": incentivesRaw[n].token,
                "decimals": decimals[incentivesRaw[n].token],
                "amount": incentivesRaw[n].amount.toString(),
                "maxPerVote": incentivesRaw[n].maxPerVote.toString(),
                "excluded": incentivesRaw[n].excluded,
            };
            // if _round is earlier than current round, include additional data
            if(_round < round) {
                incentives[gauges[i]][j].distributed = incentivesRaw[n].distributed.toString();
                incentives[gauges[i]][j].recycled = incentivesRaw[n].recycled.toString();
                incentives[gauges[i]][j].depositor = incentivesRaw[n].depositor.toString();
            }
            n++;
        }
    }
    return incentives;
}

// get incentives for a specified network and depositor
async function _getIncentivesByUser(network, user) {
    // initialize providers and contracts
    await mProviders[network].init()
    if (!contracts[network]) return null;

    // declare arrays we will need
    var userRounds = [];
    var userRoundsLength = [];
    var userGauges = [];
    var userGaugesLength = [];
    var userIncentivesLengths = [];
    var userIncentives = {};

    // get user rounds and gauges counts
    calls[network] = [];
    calls[network].push(mContracts[network].userRoundsLength(user));
    calls[network].push(mContracts[network].userGaugesLength(user));
    try {
        var result = await mProviders[network].all(calls[network]);
        userRoundsLength = result[0];
        userGaugesLength = result[1];
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get user rounds and gauges lengths for " + user + " " + network);
        return null;
    }

    // get user rounds and gauges
    calls[network] = [];
    for (var i = 0; i < userRoundsLength; i++) {
        calls[network].push(mContracts[network].userRounds(user, i));
    }
    for (var i = 0; i < userGaugesLength; i++) {
        calls[network].push(mContracts[network].userGauges(user, i));
    }
    try {
        var result = await mProviders[network].all(calls[network]);
        // slice array since rounds were pushed first, then gauges
        userRounds = result.slice(0, userRoundsLength);
        userGauges = result.slice(userRoundsLength, userRoundsLength + userGaugesLength);
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get user rounds and gauges for " + user + " " + network);
        return null;
    }

    // get user incentives lengths for each round and gauge
    calls[network] = [];
    for (var i = 0; i < userRounds.length; i++) {
        for (var j = 0; j < userGauges.length; j++) {
            calls[network].push(mContracts[network].userDepositsLength(user, userRounds[i], userGauges[j]));
        }
    }
    try {
        var result = await mProviders[network].all(calls[network]);
        for (var i = 0; i < userRounds.length; i++) {
            // slice array since rounds and gauges were pushed, grouped by rounds, with same # gauges checked each time
            userIncentivesLengths[i] = result.slice(i * userGauges.length, (i + 1) * userGauges.length);
        }
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get user incentives lengths for " + user + " " + network);
        return null;
    }

    // get user incentives list for each round and gauge
    calls[network] = [];
    for (var i = 0; i < userRounds.length; i++) {
        for (var j = 0; j < userGauges.length; j++) {
            for (var k = 0; k < userIncentivesLengths[i][j]; k++) {
                // get indexes for each incentive
                calls[network].push(mContracts[network].userDeposits(user, userRounds[i], userGauges[j], k));
            }
        }
    }
    try {
        var result = await mProviders[network].all(calls[network]);
        var n = 0;
        for (var i = 0; i < userRounds.length; i++) {
            userIncentives[userRounds[i].toString()] = {}; // initialize round object
            for (var j = 0; j < userGauges.length; j++) {
                userIncentives[userRounds[i].toString()][userGauges[j].toString()] = []; // initialize gauge object
                for(var k = 0; k < userIncentivesLengths[i][j]; k++) {
                    userIncentives[userRounds[i].toString()][userGauges[j].toString()].push(result[n].toString());
                    n++;
                }
            }
        }
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get user incentives for " + user + " " + network);
        return null;
    }
    return userIncentives;
}

// update curve gauges local storage, max once per day
async function _getCurveGauges() {
    await Promise.resolve(curveGauges);
    if (curveGauges.lastUpdated == undefined) { curveGauges.lastUpdated = 0; }
    if (Math.floor(Date.now() / 1000) - curveGauges.lastUpdated < 60 * 60 * 24) { return; } // do not query curve api more than once per day
    var curveGaugesRaw = [];
    try {
        curveGaugesRaw = await fetch(curveGaugeEndpoint).then(res => res.json());
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get curve gauges");
        return null;
    }
    if (curveGaugesRaw.success != true) { return; } // do not update if curve api returns error
    curveGaugesRaw = curveGaugesRaw.data; // remove success and data keys
    // build curveGauges object
    curveGauges = { lastUpdated: Math.floor(Date.now() / 1000), gauges: {}};
    for (i in curveGaugesRaw) {
        curveGauges.gauges[ethers.utils.getAddress(curveGaugesRaw[i].gauge)] = curveGaugesRaw[i].shortName;
    }
    // save curve gauges to storage
    storage.write("gauges", curveGauges);
}

async function _l2round2proposal(_round) {
    // initialize providers and contracts
    await mProviders["zkevm"].init()
    // map round to proposal
    var proposalBase = _round - 48; // starting point to match with l2 deployment
    var proposals;
    var proposal;

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
            var userAmount = Number(ethers.utils.formatUnits(votes[v].baseWeight, 18));
            userAmount += Number(ethers.utils.formatUnits(votes[v].adjustedWeight, 18));
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

// export functions
module.exports = {
    round: round, // current or most recent round
    networks: Object.keys(contracts), // supported networks
    storageType: storage.storageType, // storage type
    gauges: async function () {
        await Promise.resolve(curveGauges);
        return curveGauges.gauges; // curve gauges
    },
    // get incentives for a given round, using an optional offset from the current round
    getIncentivesByOffset: async function (roundOffset = 0) {
        return await this.getIncentivesByRound(round + roundOffset);
    },
    // get incentives for a given round
    getIncentivesByRound: async function (_round = round) {
        var incentives = {};
        var promises = [];
        // batch promises for each network
        for (chain in contracts) {
            promises.push(_getIncentives(chain, _round));
        }
        var results = await Promise.all(promises);
        var n = 0; // map counter
        for (chain in contracts) {
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
        await storage.write("depositData", incentives, _round);
        return incentives;
    },
    // update list of gauges from curve api (max once per day)
    updateCurveGauges: async function () {
        await _getCurveGauges();
        return curveGauges;
    },
    // update snapshot for a given round, using an optional delay from last call
    updateSnapshot: async function (_round = round, delay = 0) {
        var shot = await snap.updateSnapshot(delay, _round);
        return shot;
    },
    // get l2 votes for a given round, in the same format as snapshot function
    l2votes: async function (_round = round) {
        return await _l2votesFull(_round);
    },
    // get prices from coingecko (not a perfect solution, but gives a rough estimate)
    coingecko: async function (tokenString) {
        call = await fetch(coingecko + tokenString);
        call = await call.json();
        formatted = {};
        for(i in call) {
            formatted[ethers.utils.getAddress(i)] = call[i].usd;
        }
        return formatted;
    },
    // get all incentive ids for a given user
    getIncentivesByUser: async function (user) {
        var promises = [];
        for (i in contracts) {
            promises.push(_getIncentivesByUser(i, user));
        }
        var results = await Promise.all(promises);
        var incentives = {};
        var n = 0; // map counter
        for(i in contracts) {
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
        await storage.write("userDeposits", incentives, user);
        return incentives;
    }

}