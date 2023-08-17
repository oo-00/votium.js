const { request, gql } = require('graphql-request');
const fetch = require('node-fetch');
const snapshot_endpoint = "https://hub.snapshot.org/graphql";
const SNAPSHOT_SCORE_API = 'https://score.snapshot.org/api/scores';

module.exports = {
    endpoint: snapshot_endpoint,
    grabProposal : async (hashId) => {
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
    },

    getVoters: async (hashId) => {
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
    },

    getVoteAllScores: async (block, voteAddresses, strategy) => {
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
        return obj.result.scores;


    },

    getVoteScores: async (block, voteAddresses, strategy) => {
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
    },

    getDelegates: async (voterAddress, snapshot_block, page) => {
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
}