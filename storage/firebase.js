// Firebase Realtime Database storage adapter for votium.js.
//
//   const admin = require('firebase-admin'); admin.initializeApp();
//   const storage = require('votium.js/storage/firebase')(admin.database(), { prefix: 'v3/', paths });
//
// A key is stored at prefix + (paths[key] ?? key) + suffix. `paths` maps votium.js keys to your
// database layout: votium.js v1's, for instance, is { depositData: 'v2/depositData/',
// gauges: 'v2/gauges', fxDepositData: 'v2fxn/depositData/', fxGauges: 'v2fxn/gauges', ... }.
// The adapter holds no credentials: pass an initialized database.

module.exports = function firebase(db, { prefix = '', paths = {} } = {}) {
    if (!db || typeof db.ref !== 'function') { throw new Error("storage/firebase: pass admin.database()"); }

    function ref(key, suffix) {
        return prefix + (paths[key] !== undefined ? paths[key] : key) + suffix;
    }

    return {
        storageType: "firebase",
        read: async function (key, suffix = "") {
            try {
                return (await db.ref(ref(key, suffix)).once('value')).val();
            } catch (err) {
                console.log(err);
                return null;
            }
        },
        write: async function (key, value, suffix = "") {
            try {
                const base = ref(key, suffix);
                // the database rejects writes over about 16MB; split big objects up to two levels deep
                if (JSON.stringify(value).length > 1000000) {
                    for (const i in value) {
                        if (typeof value[i] == "object" && JSON.stringify(value[i]).length > 1000000) {
                            for (const j in value[i]) {
                                await db.ref(base + "/" + i + "/" + j).set(value[i][j]);
                            }
                        } else {
                            await db.ref(base + "/" + i).set(value[i]);
                        }
                    }
                } else {
                    await db.ref(base).set(value);
                }
                return true;
            } catch (err) {
                console.log(err);
                return false;
            }
        }
    };
};
