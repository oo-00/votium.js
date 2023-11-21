/*

Below are several examples of data that can called from votium.js
As well as different ways to call the data, depending on your needs

Please remember to properly setup config files before running these examples
    
Several functions accept an optional "platform" parameter, which is 0 for vlCVX CRV-FRAX and 1 for vlCVX Prisma
If you do not pass this parameter, it will default to 0

*/

const votium = require('../votium.js');
const ethers = require('ethers');


async function examples() {
    // Returns current round number
    console.log("vlCVX CRV-FRAX round: " + votium.round());
    console.log("vlCVX Prisma round: " + votium.round(1));

    // Returns supported networks
    console.log("vlCVX CRV-FRAX networks: "); console.log(votium.networks());
    console.log("vlCVX Prisma networks: "); console.log(votium.networks(1));

    // Returns storage type
    console.log("storage type: " + votium.storageType);
    
    // Map of gauge addresses to gauge shortNames
    curveGauges = await votium.updateGauges();
    prismaGauges = await votium.updateGauges(1);

    console.log("curveGauges " + Object.keys(curveGauges.gauges).length);
    console.log("prismaGauges " + Object.keys(prismaGauges.gauges).length);

    // Incentives by offset
    incentivesCRVFRAX = await votium.getIncentivesByOffset(0);
    incentivesPRISMA = await votium.getIncentivesByOffset(0,1);
    

    /*

    // Returns deposits from a specific user, we'll call for all users with deposits in the current round
    await userDs(incentivesCRVFRAX, 0);
    await userDs(incentivesPRISMA, 1);

    
    console.log("----------------------\nUpdate snapshot example")
    shot = await votium.updateSnapshot(votium.round()-1, 60 * 30, 0); // update if more than 30 minutes
    if (shot.votes == undefined) {
        console.log("Snapshot not available for round " + (votium.round()-1));
        shot.votes = {gauges: {}};
    }
    shot = shot.votes.gauges; // removing some unused data
    console.log(shot);
    */
    
    // get prices from coingecko
    prices = {};
    priceString = '';
    for (chain in incentivesCRVFRAX) {
        for (g in incentivesCRVFRAX[chain]) {
            for (i in incentivesCRVFRAX[chain][g]) {
                if (prices[incentivesCRVFRAX[chain][g][i].token] == undefined) {
                    prices[incentivesCRVFRAX[chain][g][i].token] = 0;
                    priceString += ',' + incentivesCRVFRAX[chain][g][i].token;
                }
            }
        }
    }
    for (chain in incentivesPRISMA) {
        for (g in incentivesPRISMA[chain]) {
            for (i in incentivesPRISMA[chain][g]) {
                if (prices[incentivesPRISMA[chain][g][i].token] == undefined) {
                    prices[incentivesPRISMA[chain][g][i].token] = 0;
                    priceString += ',' + incentivesPRISMA[chain][g][i].token;
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
    console.log(roundObject);

    var roundObject = await votium.roundObject(votium.round(1)-1, 1);
    console.log(roundObject);

    if(votium.storageType == "firebase") {
        process.exit(); // exit if using firebase, as it will hang
    }
}

async function userDs(incentives, platform) {
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
        ids = await votium.getIncentivesByUser(users[u], platform);
        console.log("Ids for depositor "+users[u]+":");
        for (r in ids) {
            console.log(r);
            console.log(ids[r]);
        }
    }
}


examples();