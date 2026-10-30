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
const { roundProposal } = require('./rounds.js');

// how long a delegate map is reused: long enough for Curve and f(x) to share one in a run, short enough that a
// long-running instance picks up delegations and lockers added during a round
const DELEGATE_MAP_TTL = 10 * 60 * 1000;

// DEBUG: when true, the tallied shot is printed to the console instead of being
// written to storage. The api/delegateMap entry is always written.
const DEBUG = false;

module.exports = function onchainVotes({ storage, cvx }) {

// Delegation is platform-agnostic, so cache the map per proposal within a single
// process run (both Curve and Fx tally in the same main() invocation).
let delegateMapCache = { proposalId: null, map: null, at: 0 };

// vlCVX lockers from Staked events in [from, to], read in 10,000-block windows (Infura's log range limit)
async function stakedUsers(from, to) {
	const locker = cvx.contracts.vlCVX;
	const users = [];
	for (let start = from; start <= to; start += 10000) {
		const events = await locker.queryFilter(locker.filters.Staked(), start, Math.min(start + 10000 - 1, to));
		events.forEach((e) => users.push(e.args._user));
	}
	return users;
}

// The locker list is saved when the scan found new lockers, or once its lastBlock is this far behind (about a
// week), so a run's scan stays short without the whole list being rewritten every run.
const SAVE_AFTER_BLOCKS = 50000;
// Once a day, saving drops lockers with no power at the previous proposal's voting epoch or next epoch. A lock lasts
// 16 epochs, so that also covers every epoch in between: no one the current or last proposal's tally counts is
// dropped. (v2's job keeps power now or next epoch, which in a round's second week drops a delegator whose lock
// expired after the round's voting epoch.) A later lock or relock emits Staked and brings them back. Lockers just
// found are kept either way.
const PRUNE_EVERY = 86400;

// keep the updated locker list; a store that won't take it (a read-only one) still gets the updated list for this run
let lockersWritable = true;
async function saveLockers(lockers, fresh) {
	if (!lockersWritable) return;
	const now = Math.floor(Date.now() / 1000);
	let users = lockers.users;
	let prunedAt = lockers.prunedAt;
	if (!(prunedAt > now - PRUNE_EVERY)) {
		const from = (cvx.gaugeProposalId() - 1) * 2 + 230;
		const [earliest, next] = await Promise.all([cvx.usersVotingPowers(users, from), cvx.usersVotingPowers(users, cvx.currentEpoch() + 1)]);
		const keep = new Set(fresh.map((u) => u.toLowerCase()));
		users = users.filter((u) => earliest[u] > 0 || next[u] > 0 || keep.has(u.toLowerCase()));
		prunedAt = now;
	}
	try {
		await storage.write("api/lockers", { lastUpdated: now, lastBlock: lockers.lastBlock, prunedAt, users });
	} catch (e) {
		lockersWritable = false;
		console.log("api/lockers not saved (" + (e.message || e) + "); using the updated list for this run");
	}
}

// Build (and publish) the delegate -> [delegators] map for a proposal, using the
// shared locker cache as the candidate set and voting power at the proposal's
// base epoch to drop lockers with nothing to delegate.
async function buildDelegateMap(proposalId, votingEpoch) {
	if (delegateMapCache.proposalId === proposalId && delegateMapCache.map && Date.now() - delegateMapCache.at < DELEGATE_MAP_TTL) {
		return delegateMapCache.map;
	}

	var lockers = await storage.read("api/lockers");
	if (lockers == null || !Array.isArray(lockers.users)) {
		// no stored locker list (a fresh local store, say): build it from the last 20 weeks of lock events
		const head = await cvx.provider.getBlockNumber();
		lockers = { lastBlock: head, users: await cvx.getAllLockedUsers() };
		await saveLockers(lockers, []);
	} else if (typeof lockers.lastBlock === "number") {
		// add whoever has locked since the list was brought up to date (the update v2's locker job makes), so
		// new lockers' delegated weight is credited to them
		const head = await cvx.provider.getBlockNumber();
		if (head > lockers.lastBlock) {
			const known = new Set(lockers.users.map((u) => u.toLowerCase()));
			const fresh = [...new Set(await stakedUsers(lockers.lastBlock + 1, head))].filter((u) => !known.has(u.toLowerCase()));
			const behind = head - lockers.lastBlock;
			lockers = { lastBlock: head, prunedAt: lockers.prunedAt, users: lockers.users.concat(fresh) };
			if (fresh.length > 0 || behind > SAVE_AFTER_BLOCKS) { await saveLockers(lockers, fresh); }
		}
	}
	// a list without lastBlock (seeded, or kept by someone else) is used as given
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

	delegateMapCache = { proposalId, map, at: Date.now() };
	await storage.write("api/delegateMap", {
		lastUpdated: Math.floor(Date.now() / 1000),
		proposalId: proposalId,
		map: map
	});
	return map;
}

// Tally a platform's on-chain votes into per-gauge / per-voter contributions,
// attributing delegated weight back to each delegator (mirrors rebuildVote.js).
async function tally(platformName, proposalId, map, voter = null) {
	// a what-if for voter's next vote leaves its current vote out
	const allVotes = (await cvx.gaugeAllVotes(platformName, proposalId)).filter((vote) => voter == null || vote.userAddress.toLowerCase() !== voter.toLowerCase());
	const gauges = {};

	// each delegate's contributing weights, a few delegates at a time. They're credited in vote order below,
	// so the sums come out the same as reading them one by one.
	const delegated = allVotes.filter((vote) => vote.voted && vote.adjustedWeight > 0 && map[vote.userAddress] && map[vote.userAddress].length > 0);
	const contributingOf = {};
	for (let k = 0; k < delegated.length; k += 4) {
		await Promise.all(delegated.slice(k, k + 4).map(async (vote) => {
			contributingOf[vote.userAddress] = await cvx.getContributingWeights(platformName, proposalId, vote.userAddress, map[vote.userAddress]);
		}));
	}

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
			const contributing = contributingOf[vote.userAddress];
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
		const proposalId = roundProposal(_round, platform);
		const votingEpoch = proposalId * 2 + 230;
        console.log(`Round ${_round} maps to proposal ${proposalId} with voting epoch ${votingEpoch}`);
		// The current proposal is re-tallied once the stored shot is older than delay. A finished one's votes stay
		// on-chain, so it's tallied once if nothing is stored for it, then served from storage. (Its delegate map
		// uses today's locker list.) Rounds before on-chain voting have negative proposal ids: storage only.
		const current = cvx.gaugeProposalId();
		const isCurrent = proposalId === current;
		const finishedUnstored = proposalId >= 0 && proposalId < current && shot.votes == undefined;
		// a what-if (voter given) is always tallied, without that voter's vote, and never saved
		const whatIf = voter != null && proposalId >= 0 && proposalId <= current;

		if ((isCurrent && shot.lastUpdated + delay < now) || finishedUnstored || whatIf) {
			const map = await buildDelegateMap(proposalId, votingEpoch);
			shot.votes = await tally(platformName, proposalId, map, voter);
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
