const votium = require('../votium.js');
const ethers = require('ethers');
var curveGauges;


async function examples() {

    // Map of gauge addresses to gauge shortNames
    // relies on local cache of gauges.json, so may not be suitable for UIs
    curveGauges = votium.gauges; // returns gauges.json
    curveGauges = await votium.updateCurveGauges(); // updates gauges.json if more than 24 hours old

    // Returns current or most recent round number
    console.log("round: " + votium.round);

    // Returns supported networks
    console.log("networks: "); console.log(votium.networks);

    // Returns deposits from a specific user
    ids = await votium.getIncentivesByUser("0xdC7C7F0bEA8444c12ec98Ec626ff071c6fA27a19");
    console.log("Ids for depositor 0xdC7C7F0bEA8444c12ec98Ec626ff071c6fA27a19");
    for (r in ids) {
        console.log(r);
        console.log(ids[r]);
    }

    // There are two methods for fetching incentives for a given round
    // Both functions accomplish the same goal but developers may have a preference for how a round is called

    console.log("----------------------\nGet incentives by offset examples")
    incentives = await getIncentivesByOffsetExamples(); // examples below
    console.log("----------------------\nGet incentives by round examples")
    await getIncentivesByRoundExamples();

    console.log("----------------------\nUpdate snapshot example")
    shot = await votium.updateSnapshot(votium.round, 60 * 15); // update if more than 15 minutes
    if (shot.votes == undefined) {
        console.log("Snapshot not available for round " + votium.round);
        return;
    }
    shot = shot.votes.gauges; // removing some unused data
    console.log(shot);

    console.log("----------------------\nUpdate l2 votes example")
    var l2votes = await votium.l2votes(votium.round);
    l2votes = l2votes.gauges; // removing some unused data, l2votes format == shot.votes format
    console.log(l2votes);
    
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
    prices = await votium.coingecko(priceString.substring(1));
    console.log("Prices as reported by coingecko")
    console.log(prices);


    // putting it together
    console.log("----------------------\n")

    // some examples of how to use the data
    var totalUSD = 0; // total USD available for all gauges
    var totalConsumedUSD = 0; // total USD consumed for all gauges
    var gaugeUSD = {}; // USD available for each gauge
    var gaugeConsumedUSD = {}; // USD consumed for each gauge
    var optimisticTotalUSD = 0; // total USD available for all gauges, assuming 25m vlCVX voted for gauges with maxPerVote
    var optimisticGaugeUSD = {}; // USD available for each gauge, assuming 25m vlCVX voted for gauges with maxPerVote

    // cycle through different supported networks
    for (chain in incentives) {
        // cycle through different gauges
        for (gauge in incentives[chain]) {
            // set initial object entry values to 0
            gaugeUSD[gauge] = 0;
            gaugeConsumedUSD[gauge] = 0;
            optimisticGaugeUSD[gauge] = 0;

            // if gauge is not in snapshot, skip
            if (shot[gauge] == undefined) {
                if (votium.gauges[gauge] == undefined) continue;
                var vote = { total: 0 };
            } else {
                var vote = shot[gauge]; // for readability
            }

            console.log("Gauges with rewards for round " + votium.round + ":\n");
            console.log(gauge + ": " + votium.gauges[gauge]);
            console.log("   Votes for gauge: " + vote.total);
            console.log("   Rewards for gauge:");
            for (i in incentives[chain][gauge]) {
                var incentive = incentives[chain][gauge][i]; // for readability

                // convert amounts to human readable format
                incentive.amount = ethers.utils.formatUnits(incentive.amount, incentive.decimals);
                incentive.maxPerVote = ethers.utils.formatUnits(incentive.maxPerVote, incentive.decimals);

                // check if entire incentive is consumed, or if there is a maxPerVote
                if (incentive.maxPerVote != 0) {
                    // if total amount is greater than maxPerVote*votes, entire reward is not consumed
                    incentive.consumedAmount = incentive.amount > incentive.maxPerVote * vote.total ? Math.floor(incentive.maxPerVote * vote.total) : incentive.amount;
                    // optimistic total USD available is based on 25m vlCVX voting for gauges with maxPerVote
                    // check if maxPerVote*25m is greater than total amount
                    var optimisticAmount = incentive.maxPerVote * 25000000 > incentive.amount ? incentive.amount : incentive.maxPerVote * 25000000;
                    // increase optimistic totals
                    optimisticGaugeUSD[gauge] += optimisticAmount * prices[incentive.token]; 
                    optimisticTotalUSD += optimisticAmount * prices[incentive.token];
                } else {
                    // if there is no maxPerVote, entire reward is consumed
                    incentive.consumedAmount = incentive.amount;
                    // increase optimistic totals
                    optimisticGaugeUSD[gauge] += incentive.amount * prices[incentive.token];
                    optimisticTotalUSD += incentive.amount * prices[incentive.token];
                }
                var total = incentive.amount * prices[incentive.token]; // readablity
                var consumed = incentive.consumedAmount * prices[incentive.token];
                
                // increase totals
                gaugeConsumedUSD[gauge] += consumed;
                gaugeUSD[gauge] += total;
                totalConsumedUSD += consumed;
                totalUSD += total;
                console.log("      " + incentive.token + ": " + incentive.consumedAmount + "/" + incentive.amount + " ($" + consumed + ")");
            }
            console.log("   Total gauge USD consumed:   $" + gaugeConsumedUSD[gauge]);
            console.log("   Total gauge USD available:  $" + gaugeUSD[gauge]);
            console.log("   Hypothetical USD available: $" + optimisticGaugeUSD[gauge]);
            console.log("   $/vlCVX: $" + gaugeConsumedUSD[gauge] / vote.total)
        }
        console.log("Total USD consumed:     $" + totalConsumedUSD);
        console.log("Total USD available:    $" + totalUSD);
        console.log("Total Hypothetical USD: $" + optimisticTotalUSD + " (based on 25m vlCVX for maxPerVote)");
    }
}

// Get incentives by passing an offset from current round
async function getIncentivesByOffsetExamples() {

    console.log("incentives for current or most recent round");
    var incentives = await votium.getIncentivesByOffset(); // same as 0
    for (chain in incentives) {
        console.log(chain); // which network the incentives belong to
        for (gauge in incentives[chain]) {
            console.log(gauge + ": " + curveGauges.gauges[gauge]);
            console.log(incentives[chain][gauge]);
        }
    }

    return incentives;

    /*  Other examples

        console.log("incentives for previous round");
        var incentives = await votium.getIncentivesByOffset(-1);
        console.log(incentives);

        console.log("incentives for next round");
        var incentives = await votium.getIncentivesByOffset(1);
        console.log(incentives);

        console.log("incentives for round 50");
        var incentives = await votium.getIncentivesByOffset(50-votium.round);
        console.log(incentives);
    */
}


// Get incentives by passing a round number
async function getIncentivesByRoundExamples() {

    console.log("incentives for round 51");
    var incentives = await votium.getIncentivesByRound(51);
    for (chain in incentives) {
        console.log(chain); // which network the incentives belong to
        for (gauge in incentives[chain]) {
            console.log(gauge + ": " + curveGauges.gauges[gauge]);
            console.log(incentives[chain][gauge]);
        }
    }

    /*  Other examples

        console.log("incentives for current or most recent round");
        var incentives = await votium.getIncentivesByRound(); // same as votium.round
        console.log(incentives);

        console.log("incentives for previous round");
        var incentives = await votium.getIncentivesByRound(votium.round-1);
        console.log(incentives);

        console.log("incentives for next round");
        var incentives = await votium.getIncentivesByRound(votium.round+1);
        console.log(incentives);
    */
}


examples();