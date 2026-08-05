// Two chains, one wallet. The judgement is on GenLayer, the money is on Base
// Sepolia, and a user should never have to know which one a button needs.
//
// So every write states the network it signs for, the network is switched
// before anything is signed, and a wallet that refuses to switch produces a
// sentence that says what happened rather than a hex error code.
import { createClient } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import { BrowserProvider, Contract, parseUnits, formatUnits } from 'ethers';

export const GEN_CHAIN_ID_HEX = '0x107d';   // 4221
export const BASE_CHAIN_ID_HEX = '0x14a34'; // 84532

const GEN_PARAMS = {
  chainId: GEN_CHAIN_ID_HEX,
  chainName: 'GenLayer Asimov',
  nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
  rpcUrls: ['https://rpc-asimov.genlayer.com'],
  blockExplorerUrls: ['https://explorer-asimov.genlayer.com'],
};

const BASE_PARAMS = {
  chainId: BASE_CHAIN_ID_HEX,
  chainName: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://sepolia.base.org'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
};

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];

let account = null;
let config = null;
const genReader = createClient({ chain: testnetAsimov });

export const currentAccount = () => account;
export const usdc = (units) => formatUnits(BigInt(units || 0), 6);
export const toUnits = (amount) => parseUnits(String(amount), 6);
export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export async function loadConfig() {
  if (config) return config;
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('the server did not answer');
  config = await res.json();
  return config;
}

async function switchTo(params) {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask to sign anything.');
  const current = await window.ethereum.request({ method: 'eth_chainId' });
  if (String(current).toLowerCase() === params.chainId) return;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: params.chainId }] });
  } catch (err) {
    if (err && (err.code === 4902 || err.code === -32603)) {
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [params] });
      return;
    }
    throw new Error(
      `This step signs on ${params.chainName}. Your wallet stayed on another network, `
      + 'and a transaction signed there would be rejected.'
    );
  }
}

export const useGenLayer = () => switchTo(GEN_PARAMS);
export const useBase = () => switchTo(BASE_PARAMS);

// genlayer-js hands the wallet a fully specified transaction, filling in fields
// wallets would rather compute themselves, and a wallet that dislikes one of
// them says only that a parameter was invalid. It is given what it cannot work
// out for itself, and if it still objects the gas price goes too, since a chain
// quoting zero is the likeliest objection.
const WALLET_COMPUTES = ['nonce', 'gas', 'type', 'chainId'];

function walletFriendly(provider) {
  return {
    ...provider,
    request: async (payload) => {
      if (payload?.method !== 'eth_sendTransaction') return provider.request(payload);
      const trimmed = { ...(payload.params?.[0] ?? {}) };
      for (const key of WALLET_COMPUTES) delete trimmed[key];
      try {
        return await provider.request({ method: 'eth_sendTransaction', params: [trimmed] });
      } catch (err) {
        if (err?.code !== -32602 || trimmed.gasPrice === undefined) throw err;
        const withoutPrice = { ...trimmed };
        delete withoutPrice.gasPrice;
        return provider.request({ method: 'eth_sendTransaction', params: [withoutPrice] });
      }
    },
  };
}

export async function connect() {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask to sign anything.');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  account = accounts[0];
  return account;
}

// ---------------------------------------------------------------- GenLayer

const isTransient = (e) => {
  const s = String(e?.details || e?.message || e);
  return /fetch failed|ECONNRESET|socket|timeout|Unexpected token '<'|503|502|429|Rate limit|Server busy|execution slots|backpressure|not currently accepting|-32006|-32029|-32603/i.test(s);
};

export async function genRead(address, functionName, args = []) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const raw = await genReader.readContract({ address, functionName, args });
      try { return JSON.parse(raw); } catch { return raw; }
    } catch (e) {
      if (!isTransient(e)) throw e;
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw last;
}

export async function genWrite(address, functionName, args = [], settled) {
  await useGenLayer();
  const client = createClient({ chain: testnetAsimov, account, provider: walletFriendly(window.ethereum) });
  const hash = await client.writeContract({ address, functionName, args, value: 0n });

  // The receipt is deliberately not what this waits on. Asked through a wallet
  // provider, the SDK reaches the consensus contract with a plain eth_call, and
  // that address answers with nothing on this network, so a transaction that
  // was accepted reads as a failure. What a person actually wants to know is
  // whether the thing they asked for happened, so that is what is checked: the
  // contract is read back until it shows the change.
  if (typeof settled === 'function') {
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      try { if (await settled()) return hash; } catch { /* keep asking */ }
    }
    throw new Error('The transaction was signed but the contract has not shown the change yet. '
      + 'Give it a minute and reload: nothing is lost, GenLayer settles in its own time.');
  }

  try {
    await genReader.waitForTransactionReceipt({ hash, status: 'ACCEPTED', retries: 120, interval: 5000 });
  } catch { /* the send is what matters; the caller verifies */ }
  return hash;
}

// -------------------------------------------------------------------- Base

export async function baseContract(address, abi) {
  await useBase();
  const provider = new BrowserProvider(window.ethereum);
  return new Contract(address, abi, await provider.getSigner());
}

// Reads switch the network too. A wallet left on GenLayer after signing an
// application will happily answer a call meant for Base, with nonsense or an
// error, and the page then cannot tell whether an escrow is funded. That
// silence is worse than a wrong number: buttons disappear and nobody knows why.
export async function baseRead(address, abi, fn, args = []) {
  await useBase();
  const provider = new BrowserProvider(window.ethereum);
  return new Contract(address, abi, provider)[fn](...args);
}

export async function baseSend(address, abi, fn, args = []) {
  const contract = await baseContract(address, abi);
  const tx = await contract[fn](...args);
  await tx.wait();
  return tx.hash;
}
