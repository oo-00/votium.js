// The part of ethers-multicall (and its archive-block fork @pelith/ethers-multicall) that votium.js
// uses, on ethers 6. Both libraries only work with ethers 5.
//
//   const { Contract, Provider } = require('./multicall.js');
//   const token = new Contract(address, abi);             // no provider: it only builds calls
//   const mc = new Provider(provider);                    // an ethers 6 provider
//   const [decimals, symbol] = await mc.all([token.decimals(), token.symbol()], blockTag);
//
// Calls go through Multicall3's aggregate(), at the same address on mainnet, Optimism, Arbitrum and
// Polygon zkEVM. Like ethers-multicall, one failing call fails the whole batch, and a function with
// one output returns that value, with several a Result.

const { ethers } = require('ethers');

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = ['function aggregate((address target, bytes callData)[] calls) payable returns (uint256 blockNumber, bytes[] returnData)'];

// ethers 5 decoded integers of 48 bits or fewer as numbers and wider ones as BigNumbers; ethers 6
// decodes every integer as a bigint. Small ones go back to numbers, so what's built from them (token
// decimals, counts, timestamps) and stored keeps its ethers 5 form.
function asV5(value, type) {
    if (type.baseType === 'tuple') {
        return ethers.Result.fromItems(type.components.map((c, i) => asV5(value[i], c)), type.components.map((c) => c.name || null));
    }
    if (type.baseType === 'array') {
        return ethers.Result.fromItems(value.map((v) => asV5(v, type.arrayChildren)));
    }
    const int = /^u?int(\d*)$/.exec(type.baseType);
    if (int && Number(int[1] || 256) <= 48) { return Number(value); }
    return value;
}

// a contract's view functions as call builders: contract.fn(...args) returns a call for Provider.all
class Contract {
    constructor(address, abi) {
        this.address = address;
        this.interface = new ethers.Interface(abi);
        this.interface.forEachFunction((fragment) => {
            if (this[fragment.name] === undefined) {
                this[fragment.name] = (...params) => ({ contract: this, fragment, params });
            }
        });
    }
}

class Provider {
    constructor(provider) {
        this.provider = provider;
        this.multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
    }

    // ethers-multicall looked up the chain's multicall address here; Multicall3 has one address everywhere
    async init() {}

    // the calls' results in order, read at blockTag if given
    async all(calls, blockTag) {
        const requests = calls.map((c) => ({ target: c.contract.address, callData: c.contract.interface.encodeFunctionData(c.fragment, c.params) }));
        const [, returnData] = await this.multicall.aggregate.staticCall(requests, blockTag === undefined ? {} : { blockTag });
        return calls.map((c, i) => {
            const decoded = c.contract.interface.decodeFunctionResult(c.fragment, returnData[i]);
            const values = c.fragment.outputs.map((output, j) => asV5(decoded[j], output));
            return values.length === 1 ? values[0] : ethers.Result.fromItems(values, c.fragment.outputs.map((o) => o.name || null));
        });
    }
}

module.exports = { Contract, Provider, MULTICALL3 };
