/*

This example takes the compiled data from votium.roundObject() and displays it in a table.

*/

const votium = require('../votium.js');
const ethers = require('ethers');

const topleft = "┌"; const topright = "┐"; const bottomleft = "└"; const bottomright = "┘";
const horizontal = "─"; const vertical = "│"; const ttop = "┬"; const tbottom = "┴";
const tleft = "├"; const tright = "┤"; const cross = "┼";


async function roundTable() {
    var roundObject = await votium.roundObject();
    buildDisplay(roundObject);
    if(votium.storageType == "firebase") {
        process.exit(); // exit if using firebase, as it will hang
    }
}


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
    celllengths[5]+=2;
    celllengths[6]+=2;
    celllengths[7]+=2;
    celllengths[9]+=2;

    string = "";
    string += await buildBorders(celllengths, "top");
    for(i in rows) {
        string += vertical;
        for(var j=0;j<celllengths.length;j++) {
            var s = 0;
            if(rows[i][j] == undefined) { rows[i][j] = ""; }
            if(!(j > 5 && j <= 9)) {
                string += rows[i][j];
            } else if((j<8 || j==9) && i != 0) {
                if(rows[i][j] != "") {
                 string += "$ ";
                 s = 3;
                }
            }
            for(k = s; k < celllengths[j] - rows[i][j].toString().length + 1; k++) {
                string += " ";
            }
            if(j > 5 && j <= 9) {
                string += rows[i][j];
                if(j<8 && i != 0) {
                    string += " ";
                } else if(j==9 && i != 0) {
                    if(rows[i][j] != "") {
                        string += " ";
                    }
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

roundTable();