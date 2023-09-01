const votium = require('../votium.js');
const ethers = require('ethers');

const topleft = "┌";
const topright = "┐";
const bottomleft = "└";
const bottomright = "┘";
const horizontal = "─";
const vertical = "│";
const ttop = "┬";
const tbottom = "┴";
const tleft = "├";
const tright = "┤";
const cross = "┼";

var curveGauges;

async function buildBorders(celllengths, pos) {
    if(pos == "top") {
        use_left = topleft;
        use_right = topright;
        use_middle = horizontal;
        use_t = ttop;
    } else if(pos == "bottom") {
        use_left = bottomleft;
        use_right = bottomright;
        use_middle = horizontal;
        use_t = tbottom;
    } else if(pos == "middle") {
        use_left = tleft;
        use_right = tright;
        use_middle = horizontal;
        use_t = cross;
    }

    string = "";
    string += use_left;
    for(i in celllengths) {
        for(var j=0;j<=celllengths[i];j++) {
            string += use_middle;
        }
        if(i != celllengths.length - 1) { string += use_t; }
    }
    string += use_right;
    string += "\n";
    return string;
}

async function buildDisplay(object) {
    rows = [];
    cells = [];
    cells.push("Chain");
    cells.push("Gauge");
    cells.push("Token");
    cells.push("Amount");
    cells.push("Consumed");
    cells.push("Max Per Vote");
    cells.push("Total USD");
    cells.push("Consumed USD");
    cells.push("Votes");
    cells.push("$/vlCVX");
    rows.push(cells);
    cells = [];
    for(chain in object) {
        cells.push(chain);
        cells.push("");
        cells.push("");
        cells.push("");
        cells.push("");
        cells.push("");
        cells.push(object[chain].totals.possibleTotalUSD.toFixed(2));
        cells.push(object[chain].totals.consumedUSD.toFixed(2));
        cells.push(Math.ceil(object[chain].totals.votes));
        cells.push(object[chain].totals.perVlCVXMedian.toFixed(6));
        rows.push(cells);
        for(gauge in object[chain].gauges) {
            cells = [];
            cells.push("");
            cells.push(gauge);
            cells.push("");
            cells.push("");
            cells.push("");
            cells.push("");
            cells.push(object[chain].gauges[gauge].totals.possibleTotalUSD.toFixed(2));
            cells.push(object[chain].gauges[gauge].totals.consumedUSD.toFixed(2));
            cells.push(Math.ceil(object[chain].gauges[gauge].votes));
            cells.push(object[chain].gauges[gauge].totals.perVlCVX.toFixed(6));
            rows.push(cells);
            cells = [];
            for(i in object[chain].gauges[gauge].rewards) {
                cells.push("");
                cells.push("");
                cells.push(object[chain].gauges[gauge].rewards[i].symbol);
                cells.push(object[chain].gauges[gauge].rewards[i].amount);
                cells.push(object[chain].gauges[gauge].rewards[i].consumedAmount);
                if(object[chain].gauges[gauge].rewards[i].maxPerVote == 0) {
                    cells.push("");
                } else {
                    cells.push(object[chain].gauges[gauge].rewards[i].maxPerVote);
                }
                cells.push(object[chain].gauges[gauge].rewards[i].possibleTotalUSD.toFixed(2));
                cells.push(object[chain].gauges[gauge].rewards[i].consumedUSD.toFixed(2));
                rows.push(cells);
                cells = [];
            }
        }
    }

    celllengths = [];
    for(i in rows) {
        for(j in rows[i]) {
            if(celllengths[j] == undefined) { celllengths[j] = 0; }
            if(rows[i][j].toString().length > celllengths[j]) {
                celllengths[j] = rows[i][j].toString().length;
            }
        }
    }

    string = "";
    string += await buildBorders(celllengths, "top");
    for(i in rows) {
        string += vertical;
        for(var j=0;j<celllengths.length;j++) {
            if(rows[i][j] == undefined) { rows[i][j] = ""; }
            var s = 0;
            if(!(j > 5 && j < 9)) {
                string += rows[i][j];
            } else if(j<8 && i != 0) {
                string += "$";
                s=2;
            }
            for(k = s; k < celllengths[j] - rows[i][j].toString().length + 1; k++) {
                string += " ";
            }
            if(j > 5 && j < 9) {
                string += rows[i][j];
                if(j<8 && i != 0) {
                    string += " ";
                }
            }
            string += vertical;
        }
        string += "\n";
        if(rows[i][0] != "") { string += await buildBorders(celllengths, "middle"); }
        if(i != rows.length - 1) { string += await buildBorders(celllengths, "middle"); }
    }
    string += await buildBorders(celllengths, "bottom");
    console.log(string);
}

async function examples() {
    // Returns current round number
    console.log("round: " + votium.round);

    // Returns supported networks
    console.log("networks: "); console.log(votium.networks);

    // Returns storage type
    console.log("storage type: " + votium.storageType);
    
    // Update vlCVX merkle tree if not created for this round
    
    vlCVXMerkle = await votium.vlCVXMerkle();
    if(vlCVXMerkle == null) {
        console.log("vlCVX merkle tree not created for round " + votium.round);
        console.log("creating...");
        vlCVXMerkle = await votium.generateVlCVXMerkle(true);
        console.log("vlCVX merkle tree created for round " + votium.round);
    }

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


    // putting it together
    console.log("----------------------\n")

    // some examples of how to use the data
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
                if (curveGauges[gauge] == undefined) continue;
                if(curveGauges[gauge].active == false) continue;
                var vote = { total: 0 };
            } else {
                var vote = shot[gauge]; // for readability
            }
            
            displayObject[chain].gauges[curveGauges[gauge].shortName] = {};
            displayObject[chain].gauges[curveGauges[gauge].shortName].votes = vote.total;
            displayObject[chain].gauges[curveGauges[gauge].shortName].rewards = [];
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
                //console.log("      " + incentive.symbol + ": " + incentive.consumedAmount + "/" + incentive.amount + " ($" + consumed + ")");
                displayObject[chain].gauges[curveGauges[gauge].shortName].rewards.push({
                    symbol: incentive.symbol,
                    consumedAmount: incentive.consumedAmount,
                    amount: incentive.amount,
                    maxPerVote: incentive.maxPerVote,
                    totalUSD: total,
                    consumedUSD: consumed,
                    possibleTotalUSD: possibleAmount * prices[incentive.token],
                });
            }
            //console.log("   Total gauge USD consumed:   $" + gaugeConsumedUSD[gauge]);
            //console.log("   Total gauge USD available:  $" + gaugeUSD[gauge]);
            //console.log("   Hypothetical USD available: $" + possibleGaugeUSD[gauge]);
            //console.log("   $/vlCVX: $" + gaugeConsumedUSD[gauge] / vote.total)
            var per;
            if(vote.total == 0) {
                per = 0;
            } else {
                per = gaugeConsumedUSD[gauge] / vote.total;
                pervls.push(per);
            }
            displayObject[chain].gauges[curveGauges[gauge].shortName].totals = {
                consumedUSD: gaugeConsumedUSD[gauge],
                totalUSD: gaugeUSD[gauge],
                possibleTotalUSD: possibleGaugeUSD[gauge],
                perVlCVX: per
            }
        }
        //console.log("Total USD consumed:     $" + totalConsumedUSD);
        //console.log("Total USD available:    $" + totalUSD);
        //console.log("Total Hypothetical USD: $" + possibleTotalUSD + " (based on 25m vlCVX for maxPerVote)");
        displayObject[chain].totals = {
            votes : totalVotes,
            consumedUSD: totalConsumedUSD,
            totalUSD: totalUSD,
            possibleTotalUSD: possibleTotalUSD,
            perVlCVX: totalConsumedUSD / totalVotes,
            perVlCVXMedian: pervls.sort()[Math.floor(pervls.length/2)]
        }
    }
    console.log(displayObject)
    buildDisplay(displayObject);
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
            console.log(gauge + ": " + curveGauges[gauge].shortName);
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
            console.log(gauge + ": " + curveGauges[gauge].shortName);
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