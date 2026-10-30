// Firebase Realtime Database storage adapter for votium.js.
//
//   const admin = require('firebase-admin'); admin.initializeApp();
//   const storage = require('votium.js/storage/firebase')(admin.database(), { prefix: 'v3/', paths });
//
// A key is stored at prefix + (paths[key] ?? key) + suffix. `paths` maps votium.js keys to your
// database layout: votium.js v1's, for instance, is { depositData: 'v2/depositData/',
// gauges: 'v2/gauges', fxDepositData: 'v2fxn/depositData/', fxGauges: 'v2fxn/gauges', ... }.
// The adapter holds no credentials: pass an initialized database. Database errors are thrown: a failed
// read must not look like missing data (callers rebuild what's missing), nor a failed write pass silently.

module.exports = function firebase(db, { prefix = '', paths = {} } = {}) {
    if (!db || typeof db.ref !== 'function') { throw new Error("storage/firebase: pass admin.database()"); }

    function ref(key, suffix) {
        return prefix + (paths[key] !== undefined ? paths[key] : key) + suffix;
    }

    return {
        storageType: "firebase",
        read: async function (key, suffix = "") {
            return (await db.ref(ref(key, suffix)).once('value')).val();
        },
        write: async function (key, value, suffix = "") {
            const base = ref(key, suffix);
            // The database rejects writes over about 16MB, so bigger objects are split up to two levels deep. Up to
            // 10MB a value is written whole: one atomic set(), with no read of the old value first.
            if (JSON.stringify(value).length > 10000000) {
                // a split write sets each child on its own, so children the new value no longer has are
                // removed afterwards, as a whole-node set() removes them
                const prev = (await db.ref(base).once('value')).val();
                const old = prev && typeof prev == "object" ? prev : {};
                const stale = {};
                for (const i in old) {
                    if (!(i in value)) { stale[i] = null; }
                }
                for (const i in value) {
                    if (typeof value[i] == "object" && value[i] !== null && JSON.stringify(value[i]).length > 10000000) {
                        const oldChild = old[i] && typeof old[i] == "object" ? old[i] : {};
                        for (const j in oldChild) {
                            if (!(j in value[i])) { stale[i + "/" + j] = null; }
                        }
                        for (const j in value[i]) {
                            await db.ref(base + "/" + i + "/" + j).set(value[i][j]);
                        }
                    } else {
                        await db.ref(base + "/" + i).set(value[i]);
                    }
                }
                if (Object.keys(stale).length > 0) { await db.ref(base).update(stale); }
            } else {
                await db.ref(base).set(value);
            }
            return true;
        }
    };
};
