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

    // There are two methods for fetching incentives for a given round
    // Both functions accomplish the same goal but developers may have a preference for how a round is called

    console.log("----------------------\nGet incentives by offset examples")
    incentives = await getIncentivesByOffsetExamples(); // examples below
    console.log("----------------------\nGet incentives by round examples")
    await getIncentivesByRoundExamples(); 

    console.log("----------------------\nUpdate snapshot example")
    shot = await votium.updateSnapshot(votium.round, 60*15); // update if more than 15 minutes
    console.log(shot);

    // get prices from coingecko
    prices = {};
    priceString = '';
    for(g in incentives) {
        for(i in incentives[g]) { 
            if(prices[incentives[g][i].token] == undefined) {
                prices[incentives[g][i].token] = 0;
                priceString += ',' + incentives[g][i].token;
            }
        }
    }
    prices = await votium.coingecko(priceString.substring(1));
    console.log(prices);


    // putting it together
    console.log("----------------------\nPutting it together")
    var totalUSD = 0;
    var gaugeUSD = {};
    for(gauge in incentives) {
        gaugeUSD[gauge] = 0;
        console.log(gauge + ": " + curveGauges.gauges[gauge]);
        console.log("Votes: " + shot.votes.gauges[gauge].total);
        console.log("Rewards:");
        for(i in incentives[gauge]) {
            if(incentives[gauge][i].maxPerVote != 0) {
                incentives[gauge][i].amount = incentives[gauge][i].amount > incentives[gauge][i].maxPerVote * shot.votes.gauges[gauge].total ? incentives[gauge][i].maxPerVote * shot.votes.gauges[gauge].total : incentives[gauge][i].amount;
            }
            incentives[gauge][i].amount = ethers.utils.formatUnits(incentives[gauge][i].amount, incentives[gauge][i].decimals);
            gaugeUSD[gauge] += incentives[gauge][i].amount * prices[incentives[gauge][i].token];
            totalUSD += incentives[gauge][i].amount * prices[incentives[gauge][i].token];
            console.log(incentives[gauge][i].token + ": " + incentives[gauge][i].amount +" ($" + incentives[gauge][i].amount * prices[incentives[gauge][i].token] + ")");
        }
        console.log("Total: $" + gaugeUSD[gauge]);
        console.log("$/vlCVX: $"+ gaugeUSD[gauge]/shot.votes.gauges[gauge].total)
    }
    console.log("Grand Total: $" + totalUSD);

}

// Get incentives by passing an offset from current round
async function getIncentivesByOffsetExamples() {

    console.log("incentives for current or most recent round");
    var incentives = await votium.getIncentivesByOffset(); // same as 0
    for(i in incentives) {
        console.log(i + ": " + curveGauges.gauges[i]);
        console.log(incentives[i]);
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
    for(i in incentives) {
        console.log(i + ": " + curveGauges.gauges[i]);
        console.log(incentives[i]);
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