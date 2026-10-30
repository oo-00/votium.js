// Round timing for Votium's platforms, shared by votium.js and onchainVotes.js: Curve (0) and f(x) (2)
// run two-week rounds, YB (3) weekly ones.

const EPOCH_START = 1646265600; // Convex's vlCVX epoch 0
const WEEK = 7 * 86400;

// a round's start time
function roundEpoch(_round, platform) {
    if (platform == 2) return (_round + 1413) * 86400 * 14;
    if (platform == 0) return (_round + 1348) * 86400 * 14;
    if (platform == 3) return (_round + 2910) * WEEK;
    return null;
}

// the Convex gauge vote proposal a Curve or f(x) round is voted on (negative for rounds before on-chain voting)
function roundProposal(_round, platform) {
    return Math.floor((Math.floor((roundEpoch(_round, platform) - EPOCH_START) / WEEK) - 230) / 2);
}

module.exports = { EPOCH_START, WEEK, roundEpoch, roundProposal };
