// File storage adapter for votium.js.
//
//   const storage = require('votium.js/storage/local')('/path/to/storage');
//
// A key maps to <dir>/<key>.json, or <dir>/<key>/<suffix>.json when a suffix (a round number,
// an address) is given: the same layout as votium.js v1's storage/ folder, so an existing one
// can be used as is. Reads always come from disk.

const fs = require('fs');
const path = require('path');

module.exports = function local(dir) {
    if (!dir) { throw new Error("storage/local: pass a directory"); }
    const root = path.resolve(dir);

    function file(key, suffix) {
        const k = String(key).replace(/^\/+|\/+$/g, '');
        const p = path.resolve(root, suffix === '' || suffix === undefined ? k : k + '/' + suffix) + '.json';
        if (p !== root && !p.startsWith(root + path.sep)) { throw new Error("storage/local: key escapes the storage directory: " + key); }
        return p;
    }

    return {
        storageType: "local",
        read: async function (key, suffix = "") {
            const p = file(key, suffix);
            if (!fs.existsSync(p)) { return null; }
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        },
        write: async function (key, value, suffix = "") {
            const p = file(key, suffix);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(value, null, 2));
            return true;
        }
    };
};
