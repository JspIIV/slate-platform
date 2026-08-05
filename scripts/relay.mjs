// The relayer: carries a verdict that already exists on GenLayer to the escrow
// that holds the money on Base Sepolia.
//
// This is the one piece of the design that runs off chain, so it is worth being
// precise about what it can and cannot do. It can only deliver a message the
// bridge contract already holds. It cannot invent a winner, because the escrow
// checks that the settlement names the round address it was linked to at
// deployment. It cannot inflate an award, because the escrow refuses a total
// above the pot it actually holds. It cannot pay itself, because it never
// touches the token. And if it simply never runs, the escrow's grace period
// hands the pot back to the sponsor and every deposit back to its applicant.
//
// So the worst a broken or hostile relayer can do is delay a settlement, and
// delay has a floor: the grace period.
import { Wallet, JsonRpcProvider, Contract } from 'ethers';
import { createClient, createAccount } from '../../colophon-app/node_modules/genlayer-js/dist/index.js';
import { testnetAsimov } from '../../colophon-app/node_modules/genlayer-js/dist/chains/index.js';
import { Wallet as GenWallet } from 'file:///C:/Users/ysfym/AppData/Roaming/npm/node_modules/genlayer/node_modules/ethers/lib.esm/index.js';
import fs from 'fs';

const BASE_RPC = process.env.BASE_RPC || 'https://sepolia.base.org';
const BRIDGE = process.env.BRIDGE;
const KS = String.raw`C:\Users\ysfym\.genlayer\keystores`;
const KEY_NAME = process.env.KEY_NAME || 'padv';
const KEY_PASS = process.env.KEY_PASS || 'placard-test-adv-2026';
const ONCE = process.env.ONCE === '1';
const INTERVAL_SECONDS = Number(process.env.INTERVAL_SECONDS || 60);

const ZERO_HASH = '0x' + '0'.repeat(64);
const artifact = JSON.parse(fs.readFileSync('build/SlateEscrow.json', 'utf8'));

const keystore = fs.readFileSync(`${KS}/${KEY_NAME}.json`, 'utf8');
const provider = new JsonRpcProvider(BASE_RPC);
const baseWallet = (await Wallet.fromEncryptedJson(keystore, KEY_PASS)).connect(provider);
const genWallet = await GenWallet.fromEncryptedJson(keystore, KEY_PASS);
const gen = createClient({ chain: testnetAsimov, account: createAccount(genWallet.privateKey) });
const genReader = createClient({ chain: testnetAsimov });

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const transient = (e) => /backpressure|not currently accepting|was reverted|fetch failed|ECONNRESET|socket|timeout|Server busy|Rate limit|-32006|-32029|-32603/i
  .test(String(e?.details || e?.message || e));

async function retry(label, fn, attempts = 5) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) {
      if (!transient(e)) throw e;
      last = e;
      console.log(`  ..  ${label}: transport trouble, retry ${i}/${attempts}`);
      await sleep(20 * i);
    }
  }
  throw last;
}

// The public Base endpoint sometimes returns a receipt with a zeroed block hash
// for a transaction that is still pending, and its status field then reads as a
// revert that never happened. A receipt counts only once it names a real block.
async function confirm(tx) {
  for (let i = 0; i < 15; i++) {
    const r = await provider.getTransactionReceipt(tx.hash);
    if (r && r.blockHash && r.blockHash !== ZERO_HASH) return r;
    await sleep(3);
  }
  throw new Error(`no believable receipt for ${tx.hash}`);
}

async function pending() {
  const raw = await retry('read pending', () =>
    genReader.readContract({ address: BRIDGE, functionName: 'get_pending', args: [] }));
  return JSON.parse(raw);
}

async function deliver(message) {
  const payload = JSON.parse(message.payload);
  const winners = payload.winners.map((w) => w.address);
  const amounts = payload.winners.map((w) => BigInt(w.award_units));

  console.log(`\n>> message ${message.message_id} for escrow ${message.escrow}`);
  console.log(`   round ${payload.round}`);
  console.log(`   ${winners.length} recipient(s), ${amounts.reduce((a, b) => a + b, 0n)} units`);

  const escrow = new Contract(message.escrow, artifact.abi, baseWallet);

  // Refuse to send what the escrow will refuse anyway, so a permanent mismatch
  // is reported here rather than burned as gas on every pass of the loop.
  const linked = (await escrow.roundContract()).toLowerCase();
  if (linked !== payload.round.toLowerCase()) {
    console.log(`   REFUSED: this escrow is linked to ${linked}, not to the round that judged`);
    return false;
  }
  if (await escrow.settled()) {
    console.log('   already settled on the settlement chain, marking it delivered');
    await markDelivered(message.message_id, 'already-settled');
    return true;
  }

  const tx = await escrow.processSettlement(payload.round, winners, amounts);
  const receipt = await confirm(tx);
  if (receipt.status !== 1) {
    console.log(`   the escrow rejected it: ${tx.hash}`);
    return false;
  }
  console.log(`   settled on Base: ${tx.hash}`);
  await markDelivered(message.message_id, tx.hash);
  return true;
}

async function markDelivered(messageId, txHash) {
  const hash = await retry('mark delivered', () =>
    gen.writeContract({ address: BRIDGE, functionName: 'mark_delivered', args: [String(messageId), String(txHash)], value: 0n }));
  await retry('mark receipt', () =>
    gen.waitForTransactionReceipt({ hash, status: 'ACCEPTED', retries: 120, interval: 10000 }));
  console.log(`   recorded on GenLayer: ${hash}`);
}

async function pass() {
  const messages = await pending();
  if (messages.length === 0) { console.log('nothing pending'); return; }
  console.log(`${messages.length} settlement(s) waiting`);
  for (const m of messages) {
    try { await deliver(m); }
    catch (e) { console.log(`   failed, will try again next pass: ${String(e?.message || e).slice(0, 160)}`); }
  }
}

console.log('relayer');
console.log('  bridge  ', BRIDGE);
console.log('  base rpc', BASE_RPC);
console.log('  key     ', baseWallet.address);

if (ONCE) {
  await pass();
} else {
  for (;;) {
    await pass();
    await sleep(INTERVAL_SECONDS);
  }
}
