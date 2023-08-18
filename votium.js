// outside libraries
const { ethers } = require('ethers');
const { Contract, Provider } = require('ethers-multicall');
const fetch = require('node-fetch');
const fs = require('fs');

// temporary snapshot vote tallying
const snap = require('./snap.js');

// local json files
const config = require('./.config.json');
const contractAddresses = require('./contracts.json');
const abi = require('./abi.json');
const erc20Abi = require('./erc20Abi.json');
var curveGauges = require('./gauges.json'); // variable is updated by updateCurveGauges()

var coingecko = "https://api.coingecko.com/api/v3/simple/token_price/ethereum?vs_currencies=usd&contract_addresses=";
const curveGaugeEndpoint = "https://api.curve.fi/api/getAllGauges";


// declaring some variables used in multiple scopes
var shot;
var calls = {};
var providers = {};
var mProviders = {};
var contracts = {};
var mContracts = {};

var round = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 14)) - 1348;


// Initialize providers and votium deposit contracts (single and multicall)
for (i in config.providers) {
    // skip if provider or contract address is not defined
    if (config.providers[i] == "" || contractAddresses[i] == "") continue;
    try {
        // single and multicall uses separate providers and contract instances
        providers[i] = new ethers.providers.JsonRpcProvider(config.providers[i]);
        mProviders[i] = new Provider(providers[i]);
        contracts[i] = new ethers.Contract(contractAddresses[i], abi, providers[i]);
        mContracts[i] = new Contract(contractAddresses[i], abi);
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
                "network": network, // include network since we'll be batching promises for multiple networks
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
    var val = {};
    val[network] = userIncentives; // return network since we'll be batching promises for multiple networks
    return val;
}

// update snapshot local storage for a specified round, with specified delay between updates
async function _updateSnapshot(delay, _round) {

    // check if __dirname+'/'+_round+'.json' exists
    var exists = fs.existsSync(__dirname + '/rounds/' + _round + '.json');
    if (exists) {
        shot = require(__dirname + '/rounds/' + _round + '.json');
    } else {
        shot = {}; 
    }
    if (shot.lastUpdated == undefined) { shot.lastUpdated = 0; }

    // if lastUpdated is sooner than delay, or round has not started, return cached snapshot
    if (shot.lastUpdated + delay < Math.floor(Date.now()/1000) && _round <= round) {
        // if snapshot id is not defined, attempt to match it
        if(shot.id == undefined) {
            // get past 30 proposals from cvx.eth
            query = "{\"query\":\"query Proposals { proposals ( first: 30, skip: 0, where: { space_in: [\\\"cvx.eth\\\"]}, orderBy: \\\"created\\\", orderDirection: desc ) { id title state created choices }}\",\"variables\":null,\"operationName\":\"Proposals\"}";
            proposals = await snap.getProposals(query);

            // if no proposals, create empty array so we can continue with the rest of the function
            if (proposals == null) { 
                proposals = [];
            }

            for (i = 0; i < proposals.length; i++) {
                if (proposals[i].title.indexOf("Gauge Weight for Week") !== -1) {
                    // check if proposal was created after, but within 24 hours after round start
                    var roundstart = 1348 * 86400 * 14 + _round * 86400 * 14;
                    if (proposals[i].created > roundstart && proposals[i].created < roundstart + 86400) {
                        shot.id = proposals[i].id; // matched snapshot id
                        for(g in proposals[i].choices) {
                            // create gauge list from choice names
                            if(curveGauges.gaugesReverse[proposals[i].choices[g]] != undefined) {
                                proposals[i].choices[g] = curveGauges.gaugesReverse[proposals[i].choices[g]];
                            } else if(proposals[i].choices[g] == "VeFunder-vyper") {
                                proposals[i].choices[g] = "0xbaf05d7aa4129ca14ec45cc9d4103a9ab9a9ff60";
                            } else {
                                console.log("Could not match gauge "+proposals[i].choices[g]+" to gauge address");
                            }
                        }
                        shot.choices = proposals[i].choices; // store in round snapshot data
                        // save snapshot id to file
                        fs.writeFileSync(__dirname + '/rounds/' + _round + '.json', JSON.stringify(shot, null, 2));
                        break;
                    }
                }
            }
        }
        // if we failed to match, store lastUpdated and return empty shot object
        if (shot.id == undefined) { 
            shot.lastUpdated = Math.floor(Date.now() / 1000);
            fs.writeFileSync(__dirname + '/rounds/' + _round + '.json', JSON.stringify(shot, null, 2));
            return shot;
        }
        // if we have an id and delay has passed, update snapshot

        shot.votes = await snap.tally(shot.id, shot.choices);
        shot.lastUpdated = Math.floor(Date.now() / 1000);
        fs.writeFileSync(__dirname + '/rounds/' + _round + '.json', JSON.stringify(shot, null, 2));
    }
    return shot;
}

// update curve gauges local storage, max once per day
async function _getCurveGauges() {
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
    curveGauges = { lastUpdated: Math.floor(Date.now() / 1000), gauges: {}, gaugesReverse: {} };
    for (i in curveGaugesRaw) {
        curveGauges.gauges[ethers.utils.getAddress(curveGaugesRaw[i].gauge)] = curveGaugesRaw[i].shortName;
        curveGauges.gaugesReverse[curveGaugesRaw[i].shortName] = ethers.utils.getAddress(curveGaugesRaw[i].gauge);
    }
    // save curve gauges to file
    fs.writeFileSync(__dirname + '/gauges.json', JSON.stringify(curveGauges));
}

module.exports = {
    round: round,
    networks: Object.keys(providers),
    gauges: curveGauges.gauges,
    getIncentivesByOffset: async function (roundOffset = 0) {
        return await this.getIncentivesByRound(round + roundOffset);
    },
    getIncentivesByRound: async function (_round = round) {
        console.log("Getting incentives for round " + _round);
        var incentives = {};
        var promises = [];
        for (i in providers) {
            promises.push(_getIncentives(i, _round));
        }
        var results = await Promise.all(promises);
        for (i in results) {
            if (results[i] == null) continue;
            for (j in results[i]) {
                if (!incentives[j]) incentives[j] = [];
                for (k in results[i][j]) {
                    incentives[j].push(results[i][j][k]);
                }
            }
        }
        return incentives;
    },
    updateCurveGauges: async function () {
        await _getCurveGauges();
        return curveGauges;
    },
    updateSnapshot: async function (_round = round, delay = 0) {
        shot = await _updateSnapshot(delay, _round);
        return shot;
    },
    coingecko: async function (tokenString) {
        call = await fetch(coingecko + tokenString);
        call = await call.json();
        formatted = {};
        for(i in call) {
            formatted[ethers.utils.getAddress(i)] = call[i].usd;
        }
        return formatted;
    },
    getIncentivesByUser: async function (user) {
        var promises = [];
        for (i in providers) {
            promises.push(_getIncentivesByUser(i, user));
        }
        var results = await Promise.all(promises);
        var incentives = {};
        for(i in results) {
            incentives[Object.keys(results[i])[0]] = results[i][Object.keys(results[i])[0]];
        }
        return incentives;
    }

}