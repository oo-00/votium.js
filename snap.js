const { request, gql } = require('graphql-request');
const fetch = require('node-fetch');
const snapshot_endpoint = "https://hub.snapshot.org/graphql";
const SNAPSHOT_SCORE_API = 'https://score.snapshot.org/api/scores';

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

async function getVoteScores(block, voteAddresses, strategy) {
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
    if (obj.result.scores[0][voteAddresses[x]] != undefined) {
        totalScore = totalScore + obj.result.scores[0][voteAddresses[x]];
    }
    if (totalAddresses[voteAddresses[x]] == undefined && obj.result.scores[0][voteAddresses[x]] != undefined) {
        totalAddresses[voteAddresses[x]] = obj.result.scores[0][voteAddresses[x]]
    } else {
        if (obj.result.scores[0][voteAddresses[x]] != undefined) {
        totalAddresses[voteAddresses[x]] = totalAddresses[voteAddresses[x]] + obj.result.scores[0][voteAddresses[x]];
        }
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

module.exports = {
    endpoint: snapshot_endpoint,
    getProposals : async (query) => {
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
    },
    tally: async (toGrab, choices) => {
        var proposal = await grabProposal(toGrab);
        var snapshot_block = proposal.snapshot;
        var voters = await getVoters(toGrab);
        var votersCheck = [];
        testVoted = [];
        for (var y in voters) {
            testVoted = voters[y].voter;
        }
        for (var i in voters) {
            votersCheck.push(voters[i].voter);
        }
        var voterAllScores = await getVoteAllScores(snapshot_block, votersCheck, proposal.strategies);
        if (voterAllScores == null) {
            return {};
        }
        var delegationTotalComp = {};
        for (var i in voters) {
            if (voterAllScores[1][voters[i].voter] > 0) {
                //console.log("loading delegates from "+voters[i].voter);
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
        var voterScores = await getVoteScores(snapshot_block, votersCheck, proposal.strategies);
    
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
}