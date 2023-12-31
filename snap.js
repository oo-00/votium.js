const storage = require('./storageHandler.js');

const { request, gql } = require('graphql-request');
const fetch = require('node-fetch');
const snapshot_endpoint = "https://hub.snapshot.org/graphql";
const SNAPSHOT_SCORE_API = 'https://score.snapshot.org/api/scores';
const fs = require('fs');
var round = Math.floor(Math.floor(Date.now() / 1000) / (86400 * 14)) - 1348;


async function grabProposal(hashId) {
    const proposalQuery = gql`
    query {
        proposal(id:"${hashId}") {
            id
            title
            body
            choices
            start
            end
            snapshot
            state
            author
            created
            plugins
            network
            strategies {
            name
            params
            }
            space {
            id
            name
            }
        }
        }
    `
    var response = await request(snapshot_endpoint, proposalQuery);
    return response.proposal;
}

async function getVoters(hashId) {
    const votersQuery = gql`
    query Votes {
        votes (
            first: 1000
            where: {
            proposal: "${hashId}"
            }
            orderBy: "created",
            orderDirection: desc
        ) {
            id
            voter
            created
            proposal {
            id
            }
            choice
            space {
            id
            }
        }
        }

    `
    var response = await request(snapshot_endpoint, votersQuery);
//console.log(response);
//console.log('Number of votes: ' + response.votes.length);

    // in Nov 9th week, Convex deployer forgot to vote. This assigns their vote to veFunder just as a placeholder, 
    // to get a list of non-voting delegates for convex team to reimburse
    
    if(hashId == '0x19683e854234ed9bd75665c22e06b880f91e918b0a21aace406c09d1fcaa9c3c') {
        convexVote = {
            id: '0x0000009385d66f5d08459d00503b795599964dfb50b24d7e3784a85d7476bad0',
            voter: '0x947B7742C403f20e5FaCcDAc5E092C943E7D0277',
            created: 1699920047,
            proposal: {
              id: '0x19683e854234ed9bd75665c22e06b880f91e918b0a21aace406c09d1fcaa9c3c'
            },
            choice: {
              '272': 1
            },
            space: { id: 'cvx.eth' }
        };
        response.votes.push(convexVote);
    }
    return response.votes;
}
async function getVoteAllScores(block, voteAddresses, strategy) {
    const params = {
    space: "cvx.eth",
    network: "1",
    snapshot: Number(block),
    strategies: strategy,
    addresses: voteAddresses
    };
    var init = {
    method: 'POST',
    headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({ params })
    };
    //console.log(JSON.stringify({ params }));
    //console.log(util.inspect(init, false, null));
    var response = await fetch(SNAPSHOT_SCORE_API, init);
    try {
        var obj = await response.json();
        if(obj.result.scores == undefined) {
            respt = await response.text();
            console.log(respt);
            process.exit();
        }
        return obj.result.scores;
    } catch (e) {
        console.log(e);
        console.log(await response.text());
        return null;
    }
}

async function getVoteScores(block, voteAddresses, strategy, voter=null) {
    const params = {
    space: "cvx.eth",
    network: "1",
    snapshot: Number(block),
    strategies: strategy,
    addresses: voteAddresses
    };
    var init = {
    method: 'POST',
    headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({ params })
    };
    //console.log(JSON.stringify({ params }));
    //console.log(util.inspect(init, false, null));
    var response = await fetch(SNAPSHOT_SCORE_API, init);
    var obj = await response.json();
    if(obj.result.scores == undefined) {
        respt = await response.text();
        console.log(respt);
        process.exit();
    }
//  console.log(util.inspect(obj.result.scores, false, null));
    var totalAddresses = {};
    var totalScore = 0;

    for (var x in voteAddresses) {
        if(voteAddresses[x] == voter) {
            totalAddresses[voteAddresses[x]] = 0;
            if(obj.result.scores[0][voteAddresses[x]] != undefined) {
              totalAddresses[voteAddresses[x]] += obj.result.scores[0][voteAddresses[x]];
            }
            if(obj.result.scores[1][voteAddresses[x]] != undefined) {
              totalAddresses[voteAddresses[x]] += obj.result.scores[1][voteAddresses[x]];
            }
            continue;
        }
        if (obj.result.scores[0][voteAddresses[x]] != undefined) {
            totalScore = totalScore + obj.result.scores[0][voteAddresses[x]];
        }
        if (totalAddresses[voteAddresses[x]] == undefined && obj.result.scores[0][voteAddresses[x]] != undefined) {
            totalAddresses[voteAddresses[x]] = obj.result.scores[0][voteAddresses[x]]
        } else if (obj.result.scores[0][voteAddresses[x]] != undefined) {
            totalAddresses[voteAddresses[x]] = totalAddresses[voteAddresses[x]] + obj.result.scores[0][voteAddresses[x]];
        }
    }
//console.log('Total Score: ' + totalScore);
    return totalAddresses;
}

async function getDelegates(voterAddress, snapshot_block, page) {
    skip = (page*999);
    let res = await fetch(
        "https://gateway.thegraph.com/api/0f15b42bdeff7a063a4e1757d7e2f99e/deployments/id/QmXvEzRJXby7KFuTr7NJsM47hGefM5VckEXZrQyZzL9eJd",
        {
        headers: {
            "content-type": "application/json",
        },
        body:
            '{"query":"query { delegations (where: {delegate: \\"' +
            voterAddress +
            '\\"},  orderBy:timestamp, orderDirection: asc, first: 1000, skip: '+skip+', block: { number: ' + snapshot_block + '}) { delegator space } }"}',
        method: "POST",
        }
    );
    res = await res.text();
    res = JSON.parse(res);
    let addressList = {};
    let delegateList = [];
    let delegateListUpper = [];
    if (res.data != null) {
    //console.log('Number of delegates: ' + res.data.delegations.length);
        res.data.delegations.forEach((key) => {
        if (key.space == "cvx.eth" || key.space == null || key.space == '') {
            delegateList.push(key.delegator);
            delegateListUpper.push(key.delegator.toUpperCase());
        }
        });
        addressList.normal = delegateList;
        addressList.upper = delegateListUpper;
        //console.log(delegateList);
        return delegateList;
    }
    return null;
}
async function getProposals(query) {
    try {
        res = await fetch(snapshot_endpoint + "?", {
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

var voterPlaceholder = 0;

async function tally(toGrab, choices, voter=null) {
    var proposal = await grabProposal(toGrab);
    var snapshot_block = proposal.snapshot;
    var voters = await getVoters(toGrab);
    var votersCheck = [];
    for (var i in voters) {
        votersCheck.push(voters[i].voter);
    }
    if (voter != null) {
        votersCheck.push(voter);
    }
    var voterAllScores = await getVoteAllScores(snapshot_block, votersCheck, proposal.strategies);
    if (voterAllScores == null) {
        return {};
    }
    if(voter != null) {
        if(voterAllScores[1][voter] > 0) {
            voterPlaceholder = voterAllScores[1][voter];
        }
    }
    var delegationTotalComp = {};
    for (var i in voters) {
        if (voterAllScores[1][voters[i].voter] > 0) {
            //console.log("loading delegates from "+voters[i].voter);
            if(voters[i].voter == voter) { console.log("skipping "+voter+" delegations"); continue; }
            p = 0;
            del = await getDelegates(voters[i].voter, snapshot_block, 0);
            delegates = [];
            delegates.push.apply(delegates, del)
            while (del.length == 999 || del.length == 1000) {
                p++;
                //console.log("reading delegates page "+(p+1));
                del = await getDelegates(voters[i].voter, snapshot_block, p);
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
    var voterScores = await getVoteScores(snapshot_block, votersCheck, proposal.strategies, voter);

    //console.log("-------");
    ptot = 0;
    poolShot = {total:0,gauges:{}};
    for (i = 0; i < voters.length; i++) {
        if(voters[i].voter == voter) {
            console.log("skipping "+voter+" weights")
            continue;
        }
        userPower = voterScores[voters[i].voter];
        if (userPower > 0) {
            ptot += userPower;

            //console.log(voters[i].choice);
            userWeightDenominator = 0;
            for (n in voters[i].choice) {
                userWeightDenominator += voters[i].choice[n];
            }
            for (n in voters[i].choice) {
                gauge = choices[n-1];
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
module.exports = {
    endpoint: snapshot_endpoint,
    // update snapshot local storage for a specified round, with specified delay between updates
    updateSnapshot: async (delay, _round, platform=0, voter=null) => {
        if(platform == 0) {
            gauges = await storage.read("gauges");
            pStr = "Gauge Weight for Week";
            var roundstart = 1348 * 86400 * 14 + _round * 86400 * 14;
            store = "snapshotVoteData";
        } else if(platform==1) {
            gauges = await storage.read("prismaGauges");
            pStr = "Prisma Emissions Weight for Week";
            var roundstart = 1405 * 86400 * 14 + _round * 86400 * 14;
            store = "prismaSnapshotVoteData";
        }
        gaugesReverse = {};
        for (g in gauges.gauges) {
            if(gauges.gauges[g].shortName == undefined) { continue; }
            gaugesReverse[gauges.gauges[g].shortName] = g;
        }

        var shot = await storage.read(store, _round);
        if(shot == null) { shot = {lastUpdated:0}; }

        // if lastUpdated is sooner than delay, or round has not started, return cached snapshot
        if (shot.lastUpdated + delay < Math.floor(Date.now()/1000) && _round <= round) {
            // if snapshot id is not defined, attempt to match it
            if(shot.id == undefined) {
                // get past 30 proposals from cvx.eth
                query = "{\"query\":\"query Proposals { proposals ( first: 30, skip: 0, where: { space_in: [\\\"cvx.eth\\\"]}, orderBy: \\\"created\\\", orderDirection: desc ) { id title state created choices }}\",\"variables\":null,\"operationName\":\"Proposals\"}";
                proposals = await getProposals(query);

                // if no proposals, create empty array so we can continue with the rest of the function
                if (proposals == null) { 
                    proposals = [];
                }

                for (i = 0; i < proposals.length; i++) {
                    if (proposals[i].title.indexOf(pStr) !== -1) {
                        // check if proposal was created after, but within 24 hours after round start
                        if (proposals[i].created > roundstart && proposals[i].created < roundstart + 86400) {
                            shot.id = proposals[i].id; // matched snapshot id
                            for(g in proposals[i].choices) {
                                // create gauge list from choice names
                                if(gaugesReverse[proposals[i].choices[g]] != undefined) {
                                    proposals[i].choices[g] = gaugesReverse[proposals[i].choices[g]];
                                } else {
                                    console.log("Could not match gauge "+proposals[i].choices[g]+" to gauge address or receiver index");
                                }
                            }
                            shot.choices = proposals[i].choices; // store in round snapshot data
                            break;
                        }
                    }
                }
            }
            // if we failed to match, store lastUpdated and return empty shot object
            if (shot.id == undefined) { 
                shot.lastUpdated = Math.floor(Date.now() / 1000);
                if(voter == null) { await storage.write(store, shot, _round); }
                return shot;
            }
            // if we have an id and delay has passed, update snapshot

            shot.votes = await tally(shot.id, shot.choices, voter);
            shot.lastUpdated = Math.floor(Date.now() / 1000);
            if(voter == null) { await storage.write(store, shot, _round); }
        }
        if(voter != null) {
            shot.voter = voterPlaceholder;
        }
        return shot;
    }
}