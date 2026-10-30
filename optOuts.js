// Votium's opt-out registries (one per vlCVX vote platform; source in public/OptOutRewards).
// A voter opted out of a gauge at a proposal's epoch earns nothing from that gauge's deposits,
// and their weight there (their own vote, plus what a delegate voted for them) comes out of the
// gauge's reward denominator. Queries take the proposal's epoch; other epochs revert.
//
//   const optOuts = require('./optOuts.js')({ cvx })   cvx: a cvxonchain instance (Convex reads)

const { ethers } = require('ethers');
const registryAbi = require('./abis/optOutRegistry.json');

const REGISTRY = {
    Curve: "0x5A5c248B39702E1A35bB854858B4Ae729D9c4405",
    Fx: "0x42dC5034C0699e98e2e5c0106B913c42810a618e"
};

module.exports = function optOuts({ cvx }) {
    const registries = {};
    for (const name in REGISTRY) {
        registries[name] = new ethers.Contract(REGISTRY[name], registryAbi, cvx.provider);
    }

    function registry(platform) {
        if (registries[platform] == undefined) { throw new Error("No opt-out registry for platform " + platform); }
        return registries[platform];
    }

    // the first epoch the registry can answer for
    async function deployEpoch(platform = "Curve") {
        return Number(await registry(platform).deployEpoch());
    }

    // { gauge: number of addresses opted out at epoch }, one multicall
    async function optOutCounts(platform = "Curve", gauges, epoch) {
        const reg = registry(platform);
        const raw = await cvx.batchCall(gauges.map((gauge) => cvx.leafCall(reg, 'optOutCountAtEpoch', [gauge, epoch], (r) => Number(r[0]))));
        const counts = {};
        gauges.forEach((gauge, i) => { counts[gauge] = raw[i]; });
        return counts;
    }

    // Every address opted out of a gauge at an epoch. Reads the list a page at a time, since the
    // whole-list read has no size cap and can run out of gas, and checks it against the count.
    // Loops on `done`, never on an empty page.
    async function optedOutUsers(platform = "Curve", gauge, epoch) {
        const reg = registry(platform);
        let users = [];
        let start = 0;
        while (true) {
            const [page, nextIndex, done] = await reg.optOutAtEpochFrom(gauge, epoch, start, 500);
            users = users.concat(page);
            if (done) { break; }
            start = Number(nextIndex);
        }
        const count = Number(await reg.optOutCountAtEpoch(gauge, epoch));
        if (users.length != count) {
            throw new Error(`Opt-out list for ${gauge} at epoch ${epoch} has ${users.length} addresses, registry count is ${count}`);
        }
        return users;
    }

    // vlCVX withheld from a gauge for `users`, who must all be opted out of it at `epoch`: what
    // they voted for it themselves, plus what their delegates voted for it on their behalf.
    // Queried in slices, ordered by delegate so a delegate's group is rarely split (each split
    // part rounds down separately, a few wei at most).
    async function withheldWeight(platform = "Curve", gauge, epoch, users) {
        const reg = registry(platform);
        const delegates = await cvx.gaugeDelegatesAtEpoch(users, epoch);
        const sorted = users.slice().sort((a, b) => delegates[a].toLowerCase() < delegates[b].toLowerCase() ? -1 : 1);
        const calls = [];
        for (let i = 0; i < sorted.length; i += 50) {
            calls.push(cvx.leafCall(reg, 'withheldWeightForUsers', [gauge, epoch, sorted.slice(i, i + 50)], (r) => r[0]));
        }
        // each slice makes several platform calls per address, so give each its own RPC call
        const parts = await cvx.batchCall(calls, 1);
        return Number(ethers.formatUnits(parts.reduce((sum, part) => sum + part, 0n), 18));
    }

    // { gauge: vlCVX withheld } for the gauges anyone opted out of at epoch; {} before the
    // registry existed
    async function withheldByGauge(platform = "Curve", gauges, epoch) {
        if (gauges.length == 0 || epoch < await deployEpoch(platform)) { return {}; }
        const counts = await optOutCounts(platform, gauges, epoch);
        const withheld = {};
        for (const gauge of gauges) {
            if (counts[gauge] == 0) { continue; }
            withheld[gauge] = await withheldWeight(platform, gauge, epoch, await optedOutUsers(platform, gauge, epoch));
        }
        return withheld;
    }

    return { registries, deployEpoch, optOutCounts, optedOutUsers, withheldWeight, withheldByGauge };
};
