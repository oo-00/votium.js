/*

Below are several examples of data that can called from votium.js
As well as different ways to call the data, depending on your needs

Please remember to properly setup config files before running these examples
    
Several functions accept an optional "platform" parameter, which is 0 for vlCVX Curve, 2 for vlCVX f(x) and 3 for veYB (1 was Prisma, removed).
If you do not pass this parameter, it will default to 0

*/

const votium = require('../votium.js')({
    providers: { mainnet: process.env.RPC_URL },
    storage: require('../storage/local.js')(__dirname + '/storage'), // built as the examples run (git ignores it)
});
const ethers = require('ethers');


async function examples() {
    // Returns current round number
    console.log("vlCVX CRV-FRAX round: " + votium.round());
    console.log("vlCVX f(x) round: " + votium.round(2));

    // Returns supported networks
    console.log("vlCVX CRV-FRAX networks: "); console.log(votium.networks());
    console.log("vlCVX f(x) networks: "); console.log(votium.networks(2));

    // Returns storage type
    console.log("storage type: " + votium.storageType);
    
    // Map of gauge addresses to gauge shortNames
    curveGauges = await votium.updateGauges();
    fxGauges = await votium.updateGauges(2);

    console.log("curveGauges " + Object.keys(curveGauges.gauges).length);
    console.log("fxGauges " + Object.keys(fxGauges.gauges).length);

    // Incentives by offset
    incentivesCRVFRAX = await votium.getIncentivesByOffset(0);
    incentivesFXN = await votium.getIncentivesByOffset(0,2);
    

    /*

    // Returns deposits from a specific user, we'll call for all users with deposits in the current round
    await userDs(incentivesCRVFRAX, 0);
    await userDs(incentivesFXN, 2);

    
    console.log("----------------------\nUpdate snapshot example")
    shot = await votium.updateSnapshot(votium.round()-1, 60 * 30, 0); // update if more than 30 minutes
    if (shot.votes == undefined) {
        console.log("Snapshot not available for round " + (votium.round()-1));
        shot.votes = {gauges: {}};
    }
    shot = shot.votes.gauges; // removing some unused data
    console.log(shot);
    */
    
    // USD prices for every deposited token: api/tokens in storage if there, else DefiLlama (CoinGecko's keyless
    // by-address endpoint takes one address at a time)
    var tokens = new Set();
    for (var incentivesOf of [incentivesCRVFRAX, incentivesFXN]) {
        for (chain in incentivesOf) {
            for (g in incentivesOf[chain]) {
                for (i in incentivesOf[chain][g]) {
                    tokens.add(incentivesOf[chain][g][i].token);
                }
            }
        }
    }
    prices = await votium.prices([...tokens]);
    console.log("Prices");
    console.log(prices);

    // The above are individual functions, but you can get a complete object for a round
    // in the current state, by calling the following function
    // combining many of the above into a single returned object

    var roundObject = await votium.roundObject();
    console.log(roundObject);

    var roundObject = await votium.roundObject(votium.round(2)-1, 2);
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