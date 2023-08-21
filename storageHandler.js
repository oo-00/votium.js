const config = require('./.storageConfig.js');

var _read;
var _write;

switch(config.storageTypes[config.storageType]) {
    case "local":
        const fs = require('fs');
        _read = async (key, suffix = "") =>{
            try {
                data = require(__dirname+config.storagePaths[config.storageType][key] + suffix+".json");
                return data;
            } catch (err) {
                console.log(err);
                return null;
            }
        }
        _write = async (key, value, suffix = "") => {
            try {
                await fs.writeFileSync(__dirname+config.storagePaths[config.storageType][key] + suffix+".json", JSON.stringify(value, null, 2));
                return true;
            } catch (err) {
                console.log(err);
                return false;
            }
        }
        break;
    case "firebase":
        const functions = require("firebase-functions");
        const admin = require("firebase-admin");
        if(config.firebaseLocal) {
            admin.initializeApp({
                credential: admin.credential.cert(config.firebaseCert),
                databaseURL: config.firebaseUrl
            });
        } else {
            admin.initializeApp();
        }
        const db = admin.database();
        _read = async (key, suffix = "") => {
            try {
                data = await db.ref(config.storagePaths[config.storageType][key] + suffix).once('value');
                return data.val();
            } catch (err) {
                console.log(err);
                return null;
            }
        }
        _write = async (key, value, suffix = "") => {
            try {
                // check size of object
                var roughObjSize = JSON.stringify(value).length;
                if(roughObjSize > 1000000) {
                    // break down into smaller chunks
                    for(i in value) {
                        // check if value[i] is an object
                        if(typeof value[i] == "object") {
                            var roughIndexSize = JSON.stringify(value[i]).length;
                            if(roughIndexSize > 1000000) {
                                // break down into smaller chunks
                                for(j in value[i]) {
                                    await db.ref(config.storagePaths[config.storageType][key] + suffix + "/" + i + "/" + j).set(value[i][j]);
                                }
                            } else {
                                await db.ref(config.storagePaths[config.storageType][key] + suffix + "/" + i).set(value[i]);
                            }
                        } else {
                            await db.ref(config.storagePaths[config.storageType][key] + suffix + "/" + i).set(value[i]);
                        }
                    }
                } else {
                    await db.ref(config.storagePaths[config.storageType][key] + suffix).set(value);
                }
                return true;
            } catch (err) {
                console.log(err);
                return false;
            }
        }
        break;
    default:
        console.log("Error: Invalid storage type");
        process.exit();
}

module.exports = {
    storageType: config.storageTypes[config.storageType],
    read: async function (key, suffix = "") {
        return await _read(key, suffix);
    },
    write: async function (key, value, suffix = "") {
        return await _write(key, value, suffix);
    }
}