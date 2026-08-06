// A wallet the app can be driven with when no browser extension is available.
//
// It is not a mock. The app sees an ordinary EIP-1193 provider, takes its usual
// path, and every transaction it asks for is signed with a real test key and
// broadcast to a real network. What is missing is only the human clicking
// "confirm", which is exactly the part that cannot be automated and exactly the
// part that proves nothing about the code.
//
// Two rules keep this honest:
//   it is served only when DEV_WALLET is set, so a deployed instance cannot
//   have a key sitting behind it;
//   the app is not modified at all, so what gets exercised is the same code
//   that a person with MetaMask would exercise.
import { Wallet, JsonRpcProvider } from 'ethers';
import fs from 'fs';

const KS = String.raw`C:\Users\ysfym\.genlayer\keystores`;
const CHAINS = {
  '0x14a34': 'https://sepolia.base.org',
  '0x107d': 'https://rpc-asimov.genlayer.com',
};

const KEYS = {
  sponsor: ['padv', 'placard-test-adv-2026'],
  alice: ['ppub', 'placard-test-pub-2026'],
  bob: ['pchg', 'roster-test-chg-2026'],
};

const wallets = {};
for (const [who, [name, pass]] of Object.entries(KEYS)) {
  wallets[who] = await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/${name}.json`, 'utf8'), pass);
}

/// Handles the calls the injected provider forwards to the server. The browser
/// side holds no key: it asks, this signs.
export async function handle(who, { method, params, chainId: requestChain }) {
  const wallet = wallets[who];
  if (!wallet) throw new Error(`no such test account: ${who}`);

  // The chain comes with the request and is never remembered between them. The
  // page talks to two chains at once, and a value held on the side gets
  // overwritten by whichever request arrived last, which sends a read to the
  // wrong chain and reports a contract that exists as empty.
  const chainOf = (given) => {
    const rpc = CHAINS[String(given || '').toLowerCase()];
    if (!rpc) throw new Error(`unknown chain ${given}`);
    return rpc;
  };

  if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [wallet.address];

  if (method === 'eth_sendTransaction') {
    const tx = { ...(params?.[0] || {}) };
    const rpc = chainOf(tx.chainId || requestChain);

    if (process.env.DEV_WALLET_TRACE === '1') {
      console.log('dev wallet: raw tx', JSON.stringify(tx));
    }
    const provider = new JsonRpcProvider(rpc);
    const signer = wallet.connect(provider);

    // Only the fields a signer must not inherit from the caller are dropped.
    // The gas price is kept when the caller gave one, because GenLayer quotes
    // its own and a locally estimated price is rejected there.
    const built = { to: tx.to, data: tx.data };
    if (tx.value !== undefined && tx.value !== '0x0') built.value = BigInt(tx.value);
    if (tx.gas !== undefined) built.gasLimit = BigInt(tx.gas);
    if (tx.gasPrice !== undefined) built.gasPrice = BigInt(tx.gasPrice);

    try {
      const sent = await signer.sendTransaction(built);
      return sent.hash;
    } catch (first) {
      // A chain that quotes zero, or one that will not take a price at all,
      // refuses the transaction rather than saying which field it disliked.
      // Retry once with everything the node can work out for itself.
      const bare = { to: built.to, data: built.data };
      if (built.value !== undefined) bare.value = built.value;
      const sent = await signer.sendTransaction(bare);
      return sent.hash;
    }
  }

  // Everything else is a plain read, forwarded to the chain this very request
  // named.
  const rpc = chainOf(requestChain);
  if (process.env.DEV_WALLET_TRACE === '1' && method === 'eth_call') {
    console.log(`dev wallet: eth_call on ${requestChain} to ${params?.[0]?.to} selector ${String(params?.[0]?.data || '').slice(0, 10)}`);
  }
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

export function accountAddresses() {
  return Object.fromEntries(Object.entries(wallets).map(([who, w]) => [who, w.address]));
}

/// The script injected into the page. It implements just enough of a wallet for
/// the app to work: accounts, the current chain, switching, and sending.
export function injectedScript() {
  return `
(() => {
  let chainId = '0x14a34';
  // Which account signs is remembered across reloads, because the app connects
  // as soon as it loads and a choice made after that would arrive too late.
  try { window.__devAccount = localStorage.getItem('devAccount') || 'sponsor'; } catch { window.__devAccount = 'sponsor'; }
  let account = null;
  const listeners = {};

  async function call(method, params) {
    const who = window.__devAccount || 'sponsor';
    const res = await fetch('/dev/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ who, chainId, method, params }),
    });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error || 'wallet error'), { code: body.code || -32000 });
    return body.result;
  }

  window.ethereum = {
    isMetaMask: false,
    isDevWallet: true,
    request: async ({ method, params }) => {
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        chainId = params[0].chainId;
        (listeners.chainChanged || []).forEach((f) => f(chainId));
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        chainId = params[0].chainId;
        return null;
      }
      const result = await call(method, params);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') account = result[0];
      return result;
    },
    on: (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); },
    removeListener: () => {},
  };

  // Which test account is signing. Switched from the console the way a person
  // switches accounts in their wallet.
  window.setDevAccount = (who) => {
    window.__devAccount = who;
    try { localStorage.setItem('devAccount', who); } catch {}
    return fetch('/dev/accounts').then((r) => r.json()).then((a) => a[who]);
  };
  console.log('dev wallet ready. window.setDevAccount("alice") to switch.');
})();
`;
}
