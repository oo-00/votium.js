// What a gauge's deposits pay its voters under Votium's maxPerVote rules, in base units. Used by roundObject, and
// usable on its own: require('votium.js/caps.js').
//
// The deposit contract releases min(amount, maxPerVote × votes) of a capped deposit (maxPerVote in the deposit's
// token, 0 = uncapped) and rolls the rest into the next round, and an uncapped deposit in full. On a gauge with no
// earning votes it releases nothing. Votes are the gauge's earning votes rounded up, as Votium's reconcile submits
// them.
//
// From the stacked rule's first round (STACKED_FROM), capped deposits stack per token: the highest maxPerVote goes
// first (equal caps in index order), and each pays min(amount, maxPerVote × votes − what the gauge already pays in
// that token), or nothing. So a capped deposit isn't touched until the gauge's other rewards in its token are
// diluted below its cap, then holds that token's rate per vote at its cap until it runs out. Deposits in other
// tokens don't count. What the contract releases of a capped deposit but voters aren't paid is refunded to its
// depositor. Before that round, each capped deposit paid what it released.

// the stacked rule's first round, by platform: Curve, f(x), YB
const STACKED_FROM = { 0: 135, 2: 70, 3: 54 };

const stackedRound = (round, platform) => STACKED_FROM[platform] != null && round >= STACKED_FROM[platform];

// deposits: [{ index, token, amount, maxPerVote }] (amounts as strings, numbers or BigInts); votes: whole earning
// votes. Returns what each deposit pays voters, as BigInts in the deposits' order.
function paidOut(deposits, votes, stacked) {
    const v = BigInt(votes);
    const amount = deposits.map((d) => BigInt(d.amount));
    const cap = deposits.map((d) => BigInt(d.maxPerVote));
    const released = deposits.map((d, i) => (v == 0n ? 0n : cap[i] > 0n && cap[i] * v < amount[i] ? cap[i] * v : amount[i]));
    if (!stacked) { return released; }
    const paid = deposits.map((d, i) => (cap[i] > 0n ? 0n : released[i]));
    const inToken = {}; // what the gauge pays so far, by token
    deposits.forEach((d, i) => { const t = d.token.toLowerCase(); inToken[t] = (inToken[t] || 0n) + paid[i]; });
    const order = deposits.map((d, i) => i).filter((i) => cap[i] > 0n)
        .sort((a, b) => (cap[a] == cap[b] ? Number(deposits[a].index) - Number(deposits[b].index) : cap[b] > cap[a] ? 1 : -1));
    for (const i of order) {
        const t = deposits[i].token.toLowerCase();
        const room = cap[i] * v - inToken[t];
        if (room > 0n) {
            paid[i] = room < amount[i] ? room : amount[i];
            inToken[t] += paid[i];
        }
    }
    return paid;
}

module.exports = { STACKED_FROM, stackedRound, paidOut };
