const { ethers } = require('ethers');
const { Contract, Provider } = require('ethers-multicall');
const fetch = require('node-fetch');
const fs = require('fs');
const config = require('./.config.json');
const abi = require('./abi.json');

const erc20Abi = require('./erc20Abi.json');

const snap = require('./snap.js');

var coingecko = "https://api.coingecko.com/api/v3/simple/token_price/ethereum?vs_currencies=usd&contract_addresses=";

var curveGauges = require('./gauges.json');
const { format } = require('path');

var shot;

var calls = {};
var providers = {};
var mProviders = {};
var contracts = {};
var mContracts = {};

var round = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 14)) - 1348;

// Initialize providers and contracts (single and multicall)

for (i in config.providers) {
    if (config.providers[i] == "" || config.contracts[i] == "") continue;
    try {
        providers[i] = new ethers.providers.JsonRpcProvider(config.providers[i]);
        mProviders[i] = new Provider(providers[i]);
        contracts[i] = new ethers.Contract(config.contracts[i], abi, providers[i]);
        mContracts[i] = new Contract(config.contracts[i], abi);
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not connect to " + i);
    }
}

async function _getIncentives(network, _round) {
    await mProviders[network].init()
    if (!contracts[network]) return null;
    var gauges = [];
    var incentives = {};
    var incentivesRaw = [];
    var incentivesLengths = [];
    var gaugesLength = await contracts[network].gaugesLength(_round);
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

    calls[network] = [];
    for (var i = 0; i < gauges.length; i++) {
        for (var j = 0; j < incentivesLengths[i]; j++) {
            calls[network].push(mContracts[network].viewIncentive(_round, gauges[i], j));
        }
    }
    try {
        incentivesRaw = await mProviders[network].all(calls[network]);
    }
    catch (e) {
        console.log("Error: " + e);
        console.log("Could not get incentives for " + network + " round " + _round + " gauge " + gauges[i] + " incentive " + j);
        return null;
    }

    decimals = {};
    tokenContracts = {};
    calls[network] = [];
    for(i in incentivesRaw) {
        if(decimals[incentivesRaw[i].token] == undefined) {
            tokenContracts[incentivesRaw[i].token] = new Contract(incentivesRaw[i].token, erc20Abi);
            decimals[incentivesRaw[i].token] = 0;
            calls[network].push(tokenContracts[incentivesRaw[i].token].decimals());
        }
    }
    try {
        decimalsRaw = await mProviders[network].all(calls[network]);
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get decimals for " + network);
        return null;
    }
    decimals = {};
    n = 0;
    for(i in incentivesRaw) {
        if(decimals[incentivesRaw[i].token] == undefined) {
            decimals[incentivesRaw[i].token] = decimalsRaw[n];
            n++;
        }
    }
    var offset = 0;
    for (var i = 0; i < gauges.length; i++) {
        incentives[gauges[i]] = [];
        for (var j = 0; j < incentivesLengths[i]; j++) {
            incentives[gauges[i]][j] = {
                "index": j,
                "token": incentivesRaw[offset].token,
                "decimals": decimals[incentivesRaw[offset].token],
                "amount": incentivesRaw[offset].amount.toString(),
                "maxPerVote": incentivesRaw[offset].maxPerVote.toString(),
                "excluded": incentivesRaw[offset].excluded,
                "network": network,
            };
            offset++;
        }
    }
    return incentives;
}

async function _getIncentivesByUser(network, user) {
    await mProviders[network].init()
    if (!contracts[network]) return null;
    calls[network] = [];
    calls[network].push(mContracts[network].userRoundsLength(user));
    calls[network].push(mContracts[network].userGaugesLength(user));
    var userRounds = [];
    var userRoundsLength = [];
    var userGauges = [];
    var userGaugesLength = [];
    try {
        var result = await mProviders[network].all(calls[network]);
        userRoundsLength = result[0];
        userGaugesLength = result[1];
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get user rounds and gauges lengths for " + user + " " + network);
        return null;
    }
    calls[network] = [];
    for (var i = 0; i < userRoundsLength; i++) {
        calls[network].push(mContracts[network].userRounds(user, i));
    }
    for (var i = 0; i < userGaugesLength; i++) {
        calls[network].push(mContracts[network].userGauges(user, i));
    }
    try {
        var result = await mProviders[network].all(calls[network]);
        userRounds = result.slice(0, userRoundsLength);
        userGauges = result.slice(userRoundsLength, userRoundsLength + userGaugesLength);
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get user rounds and gauges for " + user + " " + network);
        return null;
    }
    calls[network] = [];
    for (var i = 0; i < userRounds.length; i++) {
        for (var j = 0; j < userGauges.length; j++) {
            calls[network].push(mContracts[network].userDepositsLength(user, userRounds[i], userGauges[j]));
        }
    }
    var userIncentivesLengths = [];
    try {
        var result = await mProviders[network].all(calls[network]);
        for (var i = 0; i < userRounds.length; i++) {
            userIncentivesLengths[i] = result.slice(i * userGauges.length, (i + 1) * userGauges.length);
        }
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get user incentives lengths for " + user + " " + network);
        return null;
    }
    calls[network] = [];
    for (var i = 0; i < userRounds.length; i++) {
        for (var j = 0; j < userGauges.length; j++) {
            for (var k = 0; k < userIncentivesLengths[i][j]; k++) {
                calls[network].push(mContracts[network].userDeposits(user, userRounds[i], userGauges[j], k));
            }
        }
    }
    try {
        var result = await mProviders[network].all(calls[network]);
        var userIncentives = {};
        for (var i = 0; i < userRounds.length; i++) {
            //console.log("Round "+userRounds[i].toString());
            userIncentives[userRounds[i].toString()] = {};
            for (var j = 0; j < userGauges.length; j++) {
                //console.log("Gauge "+userGauges[j].toString());
                userIncentives[userRounds[i].toString()][userGauges[j].toString()] = result.slice((i * userGauges.length + j) * userIncentivesLengths[i][j], (i * userGauges.length + j + 1) * userIncentivesLengths[i][j]);
                for (l in userIncentives[userRounds[i].toString()][userGauges[j].toString()]) {
                    userIncentives[userRounds[i].toString()][userGauges[j].toString()][l] = userIncentives[userRounds[i].toString()][userGauges[j].toString()].toString();
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

async function _getProposals(query) {
    try {
        res = await fetch(snap.endpoint + "?", {
            "headers": { "content-type": "application/json" },
            "body": query,
            "method": "POST"
        });
        res = await res.text()
        res = JSON.parse(res);
        if (res.data.proposals[0] != null) {
            return res.data.proposals;
        } else {
            return null;
        }
    } catch (e) {
        console.log(e)
    }
}

async function _tally(toGrab) {
    var proposal = await snap.grabProposal(toGrab);
    var snapshot_block = proposal.snapshot;
    var voters = await snap.getVoters(toGrab);
    var votersCheck = [];
    testVoted = [];
    for (var y in voters) {
        testVoted = voters[y].voter;
    }
    for (var i in voters) {
        votersCheck.push(voters[i].voter);
    }
    var voterAllScores = await snap.getVoteAllScores(snapshot_block, votersCheck, proposal.strategies);
    var delegationTotalComp = {};
    for (var i in voters) {
        if (voterAllScores[1][voters[i].voter] > 0) {
            //console.log("loading delegates from "+voters[i].voter);
            p = 0;
            del = await snap.getDelegates(voters[i].voter, snapshot_block, 0);
            delegates = [];
            delegates.push.apply(delegates, del)
            while (del.length == 999 || del.length == 1000) {
                p++;
                //console.log("reading delegates page "+(p+1));
                del = await snap.getDelegates(voters[i].voter, snapshot_block, p);
                delegates.push.apply(delegates, del)
            }

            if (delegates.length > 0) {
                for (var x in delegates) {
                    delegationTotalComp[delegates[x]] = voters[i].voter;
                    if (voters.find(a => a.voter.toLowerCase() == delegates[x].toLowerCase()) == undefined) {
                        //console.log("adding delegated voter "+delegates[x])
                        votersCheck.push(delegates[x]);
                        //console.log(delegates[x]);
                        voters.push({
                            id: voters[i].id,
                            voter: delegates[x],
                            created: voters[i].created,
                            proposal: voters[i].proposal,
                            choice: voters[i].choice,
                            space: voters[i].space
                        })
                    }
                }
            }
        }
    }
    //console.log(JSON.stringify(proposal.strategies));
    var voterScores = await snap.getVoteScores(snapshot_block, votersCheck, proposal.strategies);

    //console.log("-------");
    ptot = 0;
    poolShot = {total:0,gauges:{}};
    for (i = 0; i < voters.length; i++) {
        userPower = voterScores[voters[i].voter];
        if (userPower > 0) {
            ptot += userPower;

            //console.log(voters[i].choice);
            userWeightDenominator = 0;
            for (n in voters[i].choice) {
                userWeightDenominator += voters[i].choice[n];
            }
            for (n in voters[i].choice) {
                gauge = shot.choices[n-1];
                toPool = userPower * (voters[i].choice[n] / userWeightDenominator);
                if (poolShot.gauges[gauge] == null || poolShot.gauges[gauge] == undefined) { poolShot.gauges[gauge] = {total:0,votes:{}}; }
                poolShot.gauges[gauge].votes[voters[i].voter] = toPool;
                poolShot.gauges[gauge].total += toPool;
                poolShot.total += toPool;
            }
        }
    }
    return poolShot;
}

async function _updateSnapshot(delay, _round) {
    // check if __dirname+'/'+_round+'.json' exists
    var exists = fs.existsSync(__dirname + '/rounds/' + _round + '.json');
    if (exists) {
        shot = require(__dirname + '/rounds/' + _round + '.json');
    } else {
        shot = {};
    }
    if (shot.id == undefined) {
        query = "{\"query\":\"query Proposals { proposals ( first: 20, skip: 0, where: { space_in: [\\\"cvx.eth\\\"]}, orderBy: \\\"created\\\", orderDirection: desc ) { id title state created choices }}\",\"variables\":null,\"operationName\":\"Proposals\"}";
        proposals = await _getProposals(query);
        if (proposals == null) { console.log("No proposals response"); process.exit(); }
        for (i = 0; i < proposals.length; i++) {
            if (proposals[i].title.indexOf("Gauge Weight for Week") !== -1) {
                console.log("Found gauge weight proposal");
                // check if proposal was created after, but within 24 hours after round start
                var roundstart = 1348 * 86400 * 14 + round * 86400 * 14;
                if (proposals[i].created > roundstart && proposals[i].created < roundstart + 86400) {
                    console.log("Matched round to proposal id " + proposals[i].id);
                    shot.id = proposals[i].id;
                    for(g in proposals[i].choices) {

                        if(curveGauges.gaugesReverse[proposals[i].choices[g]] != undefined) {
                            proposals[i].choices[g] = curveGauges.gaugesReverse[proposals[i].choices[g]];
                        } else if(proposals[i].choices[g] == "VeFunder-vyper") {
                            proposals[i].choices[g] = "0xbaf05d7aa4129ca14ec45cc9d4103a9ab9a9ff60";
                        } else {
                            console.log("Could not match gauge "+proposals[i].choices[g]+" to gauge address");
                        }
                    }
                    shot.choices = proposals[i].choices;
                    // save snapshot id to file
                    fs.writeFileSync(__dirname + '/rounds/' + _round + '.json', JSON.stringify(shot, null, 2));
                    break;
                }
            }
        }
    }
    if (shot.id == undefined) { console.log("Could not match to snapshot id"); return false; }
    if (shot.lastUpdated == undefined) { shot.lastUpdated = 0; }
    console.log(Math.floor(Date.now()/1000));
    if (shot.lastUpdated + delay > Math.floor(Date.now()/1000)) { return shot; }
    shot.votes = await _tally(shot.id);
    shot.lastUpdated = Math.floor(Date.now() / 1000);
    fs.writeFileSync(__dirname + '/rounds/' + _round + '.json', JSON.stringify(shot, null, 2));
    return shot;
}

async function _getCurveGauges() {
    if (curveGauges.lastUpdated == undefined) { curveGauges.lastUpdated = 0; }
    if (Math.floor(Date.now() / 1000) - curveGauges.lastUpdated < 60 * 60 * 24) { return; } // do not query curve api more than once per day
    const curveGaugeEndpoint = "https://api.curve.fi/api/getAllGauges";
    var curveGaugesRaw = [];
    try {
        curveGaugesRaw = await fetch(curveGaugeEndpoint).then(res => res.json());
    } catch (e) {
        console.log("Error: " + e);
        console.log("Could not get curve gauges");
        return null;
    }
    if (curveGaugesRaw.success != true) { return; }
    curveGaugesRaw = curveGaugesRaw.data;
    curveGauges = { lastUpdated: Math.floor(Date.now() / 1000), gauges: {}, gaugesReverse: {} };
    for (i in curveGaugesRaw) {
        curveGauges.gauges[ethers.utils.getAddress(curveGaugesRaw[i].gauge)] = curveGaugesRaw[i].shortName;
        curveGauges.gaugesReverse[curveGaugesRaw[i].shortName] = ethers.utils.getAddress(curveGaugesRaw[i].gauge);
    }
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
    }
}