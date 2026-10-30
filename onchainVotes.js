// On-chain replacement for snap.js vote tallying.
//
// Produces the same `shot` shape the UI already consumes:
//   { lastUpdated, id, votes: { total, gauges: { [gaugeAddr]: { total, votes: { [voterLower]: amount } } } } }
// but sources everything from the cvxOnchain library instead of Snapshot.
//
// Also stores the delegate -> delegators map under `api/delegateMap` so it can be
// reused elsewhere without local json files.
//
//   const onchainVotes = require('./onchainVotes.js')({ storage, cvx })

const ethers = require("ethers");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EPOCH_START = 1646265600; // cvx epoch 0 (matches cvxGaugeVotes)
const WEEK = 7 * 86400;

// DEBUG: when true, the tallied shot is printed to the console instead of being
// written to storage. The api/delegateMap entry is always written.
const DEBUG = false;

module.exports = function onchainVotes({ storage, cvx }) {

// Delegation is platform-agnostic, so cache the map per proposal within a single
// process run (both Curve and Fx tally in the same main() invocation).
let delegateMapCache = { proposalId: null, map: null };

// Start timestamp of a votium 2-week round (mirrors votium.js roundEpoch()).
function roundStartTime(_round, platform) {
	if (platform == 0) return (_round + 1348) * 86400 * 14; // Curve
	return (_round + 1413) * 86400 * 14; // Fx (platform 2)
}

// Build (and publish) the delegate -> [delegators] map for a proposal, using the
// shared locker cache as the candidate set and voting power at the proposal's
// base epoch to drop lockers with nothing to delegate.
async function buildDelegateMap(proposalId, votingEpoch) {
	if (delegateMapCache.proposalId === proposalId && delegateMapCache.map) {
		return delegateMapCache.map;
	}

	var lockers = await storage.read("api/lockers");
	if (lockers == null || !Array.isArray(lockers.users)) {
		// no stored locker list (a fresh local store, say): build it from vlCVX lock events and keep it
		lockers = { lastUpdated: Math.floor(Date.now() / 1000), users: await cvx.getAllLockedUsers() };
		await storage.write("api/lockers", lockers);
	}
	var users = lockers.users;
	const powers = await cvx.usersVotingPowers(users, votingEpoch);
	const eligible = users.filter((u) => powers[u] > 0);
	const delegates = await cvx.gaugeDelegatesAtEpoch(eligible, votingEpoch);

	const map = {};
	for (const user of eligible) {
		const delegate = delegates[user];
		if (delegate && delegate !== ZERO_ADDRESS && delegate.toLowerCase() !== user.toLowerCase()) {
			if (!map[delegate]) map[delegate] = [];
			map[delegate].push(user);
		}
	}

	delegateMapCache = { proposalId, map };
	await storage.write("api/delegateMap", {
		lastUpdated: Math.floor(Date.now() / 1000),
		proposalId: proposalId,
		map: map
	});
	return map;
}

// Tally a platform's on-chain votes into per-gauge / per-voter contributions,
// attributing delegated weight back to each delegator (mirrors rebuildVote.js).
async function tally(platformName, proposalId, map) {
	const allVotes = await cvx.gaugeAllVotes(platformName, proposalId);
	const gauges = {};

	function add(gauge, user, amount) {
		if (!(amount > 0)) return;
		const g = ethers.getAddress(gauge); // checksummed to match gauge storage keys
		const uL = user.toLowerCase();
		if (!gauges[g]) gauges[g] = { total: 0, votes: {} };
		gauges[g].votes[uL] = (gauges[g].votes[uL] || 0) + amount;
		gauges[g].total += amount;
	}

	for (const vote of allVotes) {
		if (!vote.voted) continue;

		// 1) The voter's own base weight, split across their gauges (weights out of 1000000).
		if (vote.baseWeight > 0) {
			for (let i = 0; i < vote.gauges.length; i++) {
				add(vote.gauges[i], vote.userAddress, vote.baseWeight * (vote.weights[i] / 1000000));
			}
		}

		// 2) Delegated weight, attributed back to each delegator by their contributing weight.
		const delegators = map[vote.userAddress];
		if (vote.adjustedWeight > 0 && delegators && delegators.length > 0) {
			const contributing = await cvx.getContributingWeights(platformName, proposalId, vote.userAddress, delegators);
			for (const delegator of delegators) {
				const cw = contributing[delegator];
				if (!(cw > 0)) continue;
				for (let i = 0; i < vote.gauges.length; i++) {
					add(vote.gauges[i], delegator, cw * (vote.weights[i] / 1000000));
				}
			}
		}
	}

	let total = 0;
	for (const g in gauges) total += gauges[g].total;
	return { total: total, gauges: gauges };
}

return {
	// Drop-in replacement for snap.updateSnapshot(delay, _round, platform, voter).
	// Only platforms 0 (Curve) and 2 (Fx) are handled here; Snapshot-era rounds are read from storage.
	updateVotes: async (delay, _round, platform = 0, voter = null) => {
		const platformName = platform == 0 ? "Curve" : "Fx";
		const store = platform == 0 ? "snapshotVoteData" : "fxSnapshotVoteData";

		let shot = await storage.read(store, _round);
		if (shot == null) shot = { lastUpdated: 0 };

		const now = Math.floor(Date.now() / 1000);

		// Map the round to its on-chain proposal / base voting epoch.
		const roundStart = roundStartTime(_round, platform);
		const epochAtStart = Math.floor((roundStart - EPOCH_START) / WEEK);
		const proposalId = Math.floor((epochAtStart - 230) / 2);
		const votingEpoch = proposalId * 2 + 230;
        console.log(`Round ${_round} maps to proposal ${proposalId} with voting epoch ${votingEpoch}`);
		// Live on-chain data only exists for the current proposal; otherwise serve cache.
		const isCurrent = proposalId === cvx.gaugeProposalId();

		if (isCurrent && shot.lastUpdated + delay < now) {
			const map = await buildDelegateMap(proposalId, votingEpoch);
			shot.votes = await tally(platformName, proposalId, map);
			shot.id = proposalId;
			shot.lastUpdated = now;
			// voter != null is a what-if calculation and is never persisted.
			if (voter == null) {
				if (DEBUG) {
					console.log(`[DEBUG] ${store} round ${_round} (proposal ${proposalId}) shot:`, JSON.stringify(shot, null, 2));
				} else {
					await storage.write(store, shot, _round);
				}
			}
		}

		return shot;
	}
};
};
