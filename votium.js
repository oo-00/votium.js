// storage handler
const storage = require('./storageHandler.js');
// local json files
const config = require('./.config.json');
const deployments = require('./deployments.json');
const depositAbi = require('./abis/votium.json');
const erc20Abi = require('./abis/erc20.json');
const l2Abi = require('./abis/l2platform.json');
const lockerAbi = require('./abis/locker.json');
const delegationAbi = require('./abis/delegation.json');

// outside libraries
const { ethers } = require('ethers');
const EthDater = require('ethereum-block-by-date');
const { MerkleTree } = require('merkletreejs')
const keccak256 = require('keccak256')
const { Contract: MContract, Provider: MProvider } = require('@pelith/ethers-multicall'); // ethers-multicall fork with archive node support
const { setMulticallAddress, Contract, Provider } = require('ethers-multicall');
const fetch = require('node-fetch');


// temporary snapshot vote tallying
const snap = require('./snap.js');

// set missing multicall addresses
setMulticallAddress(10, "0x7Cbc68dc836e05833CF88b6676715dB805B5c0a2");
setMulticallAddress(1101, "0xcA11bde05977b3631167028862bE2a173976CA11");

// declaring some variables used in multiple scopes

var dater; // eth-dater instance, not initialized until mainnet provider is initialized

var coingecko = "https://api.coingecko.com/api/v3/simple/token_price/ethereum?vs_currencies=usd&contract_addresses=";
const curveGaugeEndpoint = "https://api.curve.fi/api/getAllGauges";

var calls = {};
var providers = {};
var mProviders = {};
var contracts = {};
var mContracts = {};
var l2platform;
var ml2platform;
var vlCVXLocker;
var delegationRegistry;
var querySize = 1000;
var round = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 14)) - 1348;
var curveGauges = storage.read("gauges"); // curve gauges
var vlCVXAddresses = storage.read("vlCVXAddresses"); // vlCVX address list

function roundEpoch(_round) { return (_round+1348) * 86400 * 14; }
if(Math.floor(Date.now()/1000)-roundEpoch(round) > 60*60*24*5) round++; // if vote is over, default to next round

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
        } else if(i == "mainnet") {
            mProvider = new MProvider(providers[i]);
            dater = new EthDater(providers[i]);
            vlCVXLocker = new ethers.Contract(config.vlCVXLocker, lockerAbi, providers[i]);
            vlCVXmLocker = new MContract(config.vlCVXLocker, lockerAbi); // needs archive version of multicall
            delegationRegistry = new MContract(config.delegationRegistry, delegationAbi); // 
        }
        if(deployments[i] == "") continue;
        contracts[i] = new ethers.Contract(deployments[i], depositAbi, providers[i]);
        mContracts[i] = new Contract(deployments[i], depositAbi);
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

    info = await _getTokenInfoFromIncentives(network, incentivesRaw);
    decimals = info.decimals;
    symbols = info.symbols;

    // build incentives object
    var n = 0; // map counter
    // building in the same way as we built the calls for incentivesRaw
    for (var i = 0; i < gauges.length; i++) {
        incentives[gauges[i]] = []; // initialize gauge incentive array
        if(curveGauges.gauges[gauges[i]] == undefined) {
            poolName = "Unknown (" + gauges[i].substr(0,6) + "...)";
            active = false;
        } else {
            poolName = curveGauges.gauges[gauges[i]].shortName;
            active = curveGauges.gauges[gauges[i]].active;
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
async function _getIncentivesByUser(network, user) {
    curveGauges = await Promise.resolve(curveGauges);
    // initialize providers and contracts
    await mProviders[network].init()
    if (!contracts[network]) return null;
    var startBlock = 17976560; // deployment block
    var currentBlock = await providers[network].getBlockNumber();
    /*
        event NewIncentive(
        uint256 _index,
        address _token,
        uint256 _amount,
        uint256 indexed _round,
        address indexed _gauge,
        uint256 _maxPerVote,
        address[] _excluded,
        address indexed _depositor,
        bool _recycled
    );
    */

    // get all incentives where _depositor == user
    // batch in 100000 block increments
    var eventsAll = [];
    while(startBlock < currentBlock){
        endBlock = startBlock + 100000;
        if(endBlock > currentBlock){
            endBlock = currentBlock;
        }
        //console.log("getting incentives from " + startBlock + " to " + endBlock);
        eventsAll.push(contracts[network].queryFilter(contracts[network].filters.NewIncentive(null, null, null, null, null, null, null, user),startBlock,endBlock));
        startBlock = endBlock;
    }
    eventsAll = await Promise.all(eventsAll);
    var events = [];
    for(var i=0; i < eventsAll.length; i++){
        events = events.concat(eventsAll[i]);
    }
    userIncentives = {};
    for(i in events) {
        round = events[i].args._round.toString();
        gauge = events[i].args._gauge;
        id = events[i].args._index.toString();
        if(userIncentives[round] == undefined) userIncentives[round] = {};
        if(userIncentives[round][gauge] == undefined) userIncentives[round][gauge] = [];
        userIncentives[round][gauge].push(id);
    }


    // get deposit data for each incentive
    calls[network] = [];
    for(r in userIncentives) {
        for(g in userIncentives[r]) {
            for(i in userIncentives[r][g]) {
                calls[network].push(mContracts[network].viewIncentive(r, g, userIncentives[r][g][i]));
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
                userIncentives[r][g][i] = {
                    "index": userIncentives[r][g][i],
                    "pool": curveGauges.gauges[g].shortName,
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

// update curve gauges local storage, max once per day
async function _getCurveGauges() {
    curveGauges = await Promise.resolve(curveGauges);
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
        curveGauges.gauges[ethers.utils.getAddress(curveGaugesRaw[i].gauge)] = {
            "shortName": curveGaugesRaw[i].shortName,
            "active": (curveGaugesRaw[i].hasNoCrv == false && curveGaugesRaw[i].is_killed == false),
        }
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
        var user = ethers.utils.getAddress(stakedEvents[i].args._user);
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
            var bal = ethers.BigNumber.from(balData[d]);
            if(bal.toString() == "0") {
                delete vlCVXAddresses.userBase[ethers.utils.getAddress(addresses[d])];
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
            var bal = ethers.BigNumber.from(balData[d]);
            vlCVXAddresses.userBase[ethers.utils.getAddress(addresses[d])] = bal.toString();
            totalVlCVX += Number(ethers.utils.formatUnits(bal,18));
        }
    }));

    //console.log("Total vlCVX: "+totalVlCVX);
    // write to storage
    await storage.write("vlCVXAddresses", vlCVXAddresses);
    //console.log("Balances cache updated");
    return vlCVXAddresses.userBase;
}

async function _getDelegations(target_block) {
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
            if(delData[d] == ethers.constants.AddressZero) {
                globalCheckList.push(addresses[d]);
            } else {
                vlCVXAddresses.userDelegation[ethers.utils.getAddress(addresses[d])] = ethers.utils.getAddress(delData[d]);
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

            var delegate = ethers.utils.getAddress(delData[d]);
            if(delegate != ethers.constants.AddressZero) {
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
            userAdjusted[user] = ethers.BigNumber.from(0);
        }
        if(userAdjusted[vlCVXAddresses.userDelegation[user]] == undefined) {
            userAdjusted[vlCVXAddresses.userDelegation[user]] = ethers.BigNumber.from(0);
        }
        if(vlCVXAddresses.userDelegation[vlCVXAddresses.userDelegation[user]] == undefined) {
            vlCVXAddresses.userDelegation[vlCVXAddresses.userDelegation[user]] = vlCVXAddresses.userDelegation[user];
        }
        if(vlCVXAddresses.userBase[vlCVXAddresses.userDelegation[user]] == undefined) {
            vlCVXAddresses.userBase[vlCVXAddresses.userDelegation[user]] = 0;
        }
        if(vlCVXAddresses.userDelegation[user] != user) {
            userAdjusted[vlCVXAddresses.userDelegation[user]] = userAdjusted[vlCVXAddresses.userDelegation[user]].add(ethers.BigNumber.from(vlCVXAddresses.userBase[user]));
        }
    }
    totalDelegated = ethers.BigNumber.from(0);
    for(user in userAdjusted) {
        totalDelegated = totalDelegated.add(userAdjusted[user]);
        userAdjusted[user] = userAdjusted[user].toString();
    }
    //console.log("Total delegated: "+ethers.utils.formatUnits(totalDelegated,18));
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
        elements.push(ethers.utils.solidityKeccak256(["address","address","uint256","int256"],[user,userDelegation[user],ethers.BigNumber.from(userBase[user]),ethers.BigNumber.from(userAdjusted[user])]));
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
module.exports = {
    round: round, // current round
    networks: Object.keys(contracts), // supported networks
    storageType: storage.storageType, // storage type
    // direct storage read
    storageRead: async function (key, suffix = "") {
        return await storage.read(key, suffix);
    },
    vlCVXMerkle: async function (_round = round) {
        return await storage.read("vlCVXMerkles", _round);
    },
    gauges: async function () {
        curveGauges = await Promise.resolve(curveGauges);
        return curveGauges.gauges; // curve gauges
    },
    // get cached incentives for a given round
    getIncentivesCached: async function (_round = round) {
        return await storage.read("depositData", _round);
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
        await storage.write("userDeposits", incentives, user.toLowerCase());
        return incentives;
    },
    generateVlCVXMerkle: async function (fullsyncAddresses=false) {
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
    roundObject : async function (_round = round) {

        curveGauges = await this.updateCurveGauges(); // grabs gauges storage and updates if data more than 24 hours old

        var incentives = await this.getIncentivesByRound(_round); // get incentives for round

        shot = await this.updateSnapshot(_round, 60 * 15); // update if more than 15 minutes, and not finalized
        if (shot.votes == undefined) {
            console.log("Snapshot not available for round " + round);
            shot.votes = {gauges: {}};
        }
        shot = shot.votes.gauges; // removing some unused data

        curveGauge = curveGauges.gauges;
        
        // get prices from coingecko
        prices = {};
        priceString = '';
        for (chain in incentives) {
            for (g in incentives[chain]) {
                for (i in incentives[chain][g]) {
                    if (prices[incentives[chain][g][i].token] == undefined) {
                        prices[incentives[chain][g][i].token] = 0;
                        priceString += ',' + incentives[chain][g][i].token;
                    }
                }
            }
        }
        prices = await this.coingecko(priceString.substring(1));



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
                    if (curveGauge[gauge] == undefined) continue;
                    if(curveGauge[gauge].active == false) continue;
                    var vote = { total: 0 };
                } else {
                    var vote = shot[gauge]; // for readability
                }
                
                displayObject[chain].gauges[curveGauge[gauge].shortName] = {};
                displayObject[chain].gauges[curveGauge[gauge].shortName].votes = vote.total;
                displayObject[chain].gauges[curveGauge[gauge].shortName].rewards = [];
                totalVotes += vote.total;
                //console.log("   Votes for gauge: " + vote.total);
                //console.log("   Rewards for gauge:");
                for (i in incentives[chain][gauge]) {
                    var incentive = incentives[chain][gauge][i]; // for code readability
                    var possibleAmount = 0; // amount of incentive available if 25m vlCVX voted for gauges with maxPerVote
                    // convert amounts to human readable format
                    incentive.amount = ethers.utils.formatUnits(incentive.amount, incentive.decimals);
                    incentive.maxPerVote = ethers.utils.formatUnits(incentive.maxPerVote, incentive.decimals);

                    // check if entire incentive is consumed, or if there is a maxPerVote
                    if (incentive.maxPerVote != 0) {
                        // if total amount is greater than maxPerVote*votes, entire reward is not consumed
                        incentive.consumedAmount = incentive.amount > incentive.maxPerVote * vote.total ? Math.floor(incentive.maxPerVote * vote.total) : incentive.amount;
                        // possible total USD available is based on 25m vlCVX voting for gauges with maxPerVote
                        // check if maxPerVote*25m is greater than total amount
                        possibleAmount = incentive.maxPerVote * 25000000 > incentive.amount ? incentive.amount : incentive.maxPerVote * 25000000;
                        // increase possible totals
                        possibleGaugeUSD[gauge] += possibleAmount * prices[incentive.token]; 
                        possibleTotalUSD += possibleAmount * prices[incentive.token];
                    } else {
                        // if there is no maxPerVote, entire reward is consumed
                        incentive.consumedAmount = incentive.amount;
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

                    displayObject[chain].gauges[curveGauge[gauge].shortName].rewards.push({
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
                if(vote.total == 0) {
                    per = 0;
                } else {
                    per = gaugeConsumedUSD[gauge] / vote.total;
                    pervls.push(per);
                }
                displayObject[chain].gauges[curveGauge[gauge].shortName].totals = {
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
                perVlCVXMedian: pervls.sort()[Math.floor(pervls.length/2)]
            }
        }
        return displayObject;
    }
}