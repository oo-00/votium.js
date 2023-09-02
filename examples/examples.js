/*

Below are several examples of data that can called from votium.js
As well as different ways to call the data, depending on your needs

Please remember to properly setup config files before running these examples
    
*/

const votium = require('../votium.js');
const ethers = require('ethers');

var curveGauges;

async function examples() {
    // Returns current round number
    console.log("round: " + votium.round);

    // Returns supported networks
    console.log("networks: "); console.log(votium.networks);

    // Returns storage type
    console.log("storage type: " + votium.storageType);
    
    /* Pending final code for merkle generation - will update this section when ready
    // Update vlCVX merkle tree if not created for this round
    
    vlCVXMerkle = await votium.vlCVXMerkle();
    if(vlCVXMerkle == null) {
        console.log("vlCVX merkle tree not created for round " + votium.round);
        console.log("creating...");
        vlCVXMerkle = await votium.generateVlCVXMerkle(true);
        console.log("vlCVX merkle tree created for round " + votium.round);
    }
    */

    // Map of gauge addresses to gauge shortNames
    // relies on local cache of gauges.json, so may not be suitable for UIs
    curveGauges = await votium.updateCurveGauges(); // grabs gauges storage and updates if data more than 24 hours old
    
    // There are two methods for fetching incentives for a given round
    // Both functions accomplish the same goal but developers may have a preference for how a round is called

    console.log("----------------------\nGet incentives by offset examples")
    incentives = await getIncentivesByOffsetExamples(); // examples below
    
    //console.log("----------------------\nGet incentives by round examples")
    //await getIncentivesByRoundExamples();

    // Returns deposits from a specific user, we'll call for all users with deposits in the current round
    console.log("----------------------\nGet deposits by user example")
    users = [];
    for(chain in incentives) {
        for(gauge in incentives[chain]) {
            for(i in incentives[chain][gauge]) {
                var deposit = incentives[chain][gauge][i];
                if(users.indexOf(deposit.depositor) == -1) {
                    users.push(deposit.depositor);
                }
            }
        }
    }
    for(u in users) {
        ids = await votium.getIncentivesByUser(users[u]);
        console.log("Ids for depositor "+users[u]+":");
        for (r in ids) {
            console.log(r);
            console.log(ids[r]);
        }
    }

    console.log("----------------------\nUpdate snapshot example")
    shot = await votium.updateSnapshot(votium.round, 60 * 30); // update if more than 30 minutes
    if (shot.votes == undefined) {
        console.log("Snapshot not available for round " + votium.round);
        shot.votes = {gauges: {}};
    }
    shot = shot.votes.gauges; // removing some unused data
    //console.log(shot);


    console.log("----------------------\nUpdate l2 votes example")
    var l2votes = await votium.l2votes(votium.round);
    if (l2votes == null) { l2votes = {gauges:{}}; }
    l2votes = l2votes.gauges; // removing some unused data, l2votes format == shot.votes format
    //console.log(l2votes);
    
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

    // The above are individual functions, but you can get a complete object for a round
    // in the current state, by calling the following function
    // combining many of the above into a single returned object

    var roundObject = await votium.roundObject();
    console.log("Compiled data from roundObject() function")
    console.log(roundObject);

    if(votium.storageType == "firebase") {
        process.exit(); // exit if using firebase, as it will hang
    }
}

// Get incentives by passing an offset from current round
async function getIncentivesByOffsetExamples() {
    
    console.log("incentives for current round");
    var incentives = await votium.getIncentivesByOffset(); 
    for (chain in incentives) {
        console.log(chain); // which network the incentives belong to
        for (gauge in incentives[chain]) {
            console.log(gauge + ": " + curveGauges.gauges[gauge].shortName);
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
            console.log(gauge + ": " + curveGauges.gauges[gauge].shortName);
            console.log(incentives[chain][gauge]);
        }
    }

    /*  Other examples

        console.log("incentives for current round");
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