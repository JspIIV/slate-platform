// One funding round, all the way through, across two chains.
//
// The point of running it in one script is that the ordering is part of the
// design: the escrow and the round have to share a deadline, the money has to
// be in place before anybody applies, and the verdict cannot cross until the
// round has closed. Every step writes its addresses to state.json so the run
// can be picked up again after a failure rather than started over, which
// matters when a single testnet transaction takes two to three minutes.
import { Wallet, JsonRpcProvider, Contract, ContractFactory, parseUnits, formatUnits } from 'ethers';
import { createClient, createAccount } from '../../colophon-app/node_modules/genlayer-js/dist/index.js';
import { testnetAsimov } from '../../colophon-app/node_modules/genlayer-js/dist/chains/index.js';
import { Wallet as GenWallet } from 'file:///C:/Users/ysfym/AppData/Roaming/npm/node_modules/genlayer/node_modules/ethers/lib.esm/index.js';
import fs from 'fs';

const BASE_RPC = 'https://sepolia.base.org';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const KS = String.raw`C:\Users\ysfym\.genlayer\keystores`;
const STATE = 'run/state.json';

const REGISTRY = process.env.REGISTRY;
const BRIDGE = process.env.BRIDGE;

const POT = parseUnits('6', 6);
const DEPOSIT = parseUnits('1', 6);
const WINDOW_SECONDS = Number(process.env.WINDOW_SECONDS || 1500);
const GRACE_SECONDS = 1800;
const CHAIN_ID = 84532;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
];
const ZERO_HASH = '0x' + '0'.repeat(64);

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const usdc = (v) => formatUnits(v, 6);
const provider = new JsonRpcProvider(BASE_RPC);
const artifact = JSON.parse(fs.readFileSync('build/SlateEscrow.json', 'utf8'));

fs.mkdirSync('run', { recursive: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

const accounts = {
  sponsor: ['padv', 'placard-test-adv-2026'],
  alice: ['ppub', 'placard-test-pub-2026'],
  bob: ['pchg', 'roster-test-chg-2026'],
};
const base = {}, gl = {};
for (const [who, [name, pass]] of Object.entries(accounts)) {
  const json = fs.readFileSync(`${KS}/${name}.json`, 'utf8');
  base[who] = (await Wallet.fromEncryptedJson(json, pass)).connect(provider);
  const gw = await GenWallet.fromEncryptedJson(json, pass);
  gl[who] = createClient({ chain: testnetAsimov, account: createAccount(gw.privateKey) });
}
const glReader = createClient({ chain: testnetAsimov });

const transient = (e) => /backpressure|not currently accepting|was reverted|fetch failed|ECONNRESET|socket|timeout|Server busy|Rate limit|-32006|-32029|-32603/i
  .test(String(e?.details || e?.message || e));
async function retry(label, fn, attempts = 6) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) {
      if (!transient(e)) throw e;
      last = e;
      console.log(`  ..  ${label}: retry ${i}/${attempts}`);
      await sleep(20 * i);
    }
  }
  throw last;
}

// ---- GenLayer helpers ------------------------------------------------------

const glRead = async (addr, fn, args = []) => {
  const raw = await retry(`read ${fn}`, () => glReader.readContract({ address: addr, functionName: fn, args }));
  try { return JSON.parse(raw); } catch { return raw; }
};
async function glSend(who, label, addr, fn, args) {
  console.log(`\n>> ${label}`);
  const hash = await retry(`send ${fn}`, () => gl[who].writeContract({ address: addr, functionName: fn, args, value: 0n }));
  const r = await retry(`receipt ${fn}`, () => gl[who].waitForTransactionReceipt({ hash, status: 'ACCEPTED', retries: 160, interval: 10000 }));
  const exec = String(r?.consensus_data?.leader_receipt?.[0]?.execution_result ?? r?.txExecutionResultName ?? '?');
  console.log('  ', hash, exec);
  return exec;
}

// ---- Base helpers ----------------------------------------------------------

async function confirm(tx) {
  for (let i = 0; i < 15; i++) {
    const r = await provider.getTransactionReceipt(tx.hash);
    if (r && r.blockHash && r.blockHash !== ZERO_HASH) return r;
    await sleep(3);
  }
  throw new Error(`no believable receipt for ${tx.hash}`);
}
async function baseSend(label, promise) {
  console.log(`\n>> ${label}`);
  const tx = await promise;
  const r = await confirm(tx);
  console.log('  ', tx.hash, r.status === 1 ? 'ok' : 'REVERTED');
  if (r.status !== 1) throw new Error(`${label} reverted`);
  return r;
}
const token = new Contract(USDC, ERC20_ABI, provider);

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        ${detail}`); }
};

console.log('sponsor', base.sponsor.address);
console.log('alice  ', base.alice.address);
console.log('bob    ', base.bob.address);

// ---- 1. the escrow, on Base ------------------------------------------------

if (!state.escrow) {
  state.closesAt = Math.floor(Date.now() / 1000) + WINDOW_SECONDS;
  console.log(`\n--- deploying the escrow, window ${WINDOW_SECONDS}s ---`);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, base.sponsor);
  const escrow = await factory.deploy(USDC, base.sponsor.address, POT, DEPOSIT, state.closesAt, GRACE_SECONDS);
  await escrow.waitForDeployment();
  state.escrow = await escrow.getAddress();
  save();
  console.log('  escrow', state.escrow);
}
const escrow = new Contract(state.escrow, artifact.abi, provider);

// ---- 2. the round, on GenLayer --------------------------------------------

if (!state.round) {
  console.log('\n--- deploying the round ---');
  const source = fs.readFileSync('contracts/slate_round.py');
  const hash = await retry('deploy round', () => gl.sponsor.deployContract({
    code: source,
    args: [
      REGISTRY, BRIDGE, state.escrow, String(CHAIN_ID), base.sponsor.address,
      'Open source developer tooling grant',
      'Fund small teams building tooling other developers can adopt',
      'The applicant must show a real, working piece of developer tooling on a page they publish, with documentation a stranger could follow. Prefer visible adoption. A page about the category rather than the applicant own work does not qualify, and a page unrelated to developer tooling does not qualify at all.',
      POT.toString(), DEPOSIT.toString(), String(state.closesAt), '5',
    ],
    leaderOnly: false,
  }));
  console.log('  deploy tx', hash);
  const r = await retry('deploy receipt', () => glReader.getTransaction({ hash }));
  const o = JSON.parse(JSON.stringify(r, (k, v) => typeof v === 'bigint' ? v.toString() : v));
  state.round = o.data?.contract_address || o.recipient;
  save();
  console.log('  round', state.round);
}

// ---- 3. link them ----------------------------------------------------------

if (!state.linked) {
  await baseSend('link the escrow to the round',
    new Contract(state.escrow, artifact.abi, base.sponsor).setRoundContract(state.round));
  await glSend('sponsor', 'record the round in the registry', REGISTRY, 'record_round', [
    state.round, state.escrow, String(CHAIN_ID), base.sponsor.address,
    'Open source developer tooling grant',
    'Fund small teams building tooling other developers can adopt',
    POT.toString(), DEPOSIT.toString(), String(state.closesAt),
  ]);
  check('the registry knows the round', await glRead(REGISTRY, 'is_round', [state.round]) === true, '');
  state.linked = true; save();
}

// ---- 4. money in -----------------------------------------------------------

if (!state.funded) {
  console.log('\n--- the sponsor funds the pot ---');
  await baseSend('approve the pot', new Contract(USDC, ERC20_ABI, base.sponsor).approve(state.escrow, POT));
  await baseSend('fund', new Contract(state.escrow, artifact.abi, base.sponsor).fund());
  check('the escrow holds the pot', (await token.balanceOf(state.escrow)) === POT, `held ${usdc(await token.balanceOf(state.escrow))}`);
  state.funded = true; save();
}

// ---- 5. applications, on both chains ---------------------------------------

const APPS = [
  ['alice', 1, 'Ripgrep', 'https://github.com/BurntSushi/ripgrep',
   'A line oriented search tool that respects gitignore, documented and widely adopted.'],
  ['bob', 2, 'Static site generators', 'https://en.wikipedia.org/wiki/Static_site_generator',
   'An encyclopedia article about the category rather than a tool we built.'],
];

if (!state.applied) {
  console.log('\n--- applications: a deposit on Base, a record on GenLayer ---');
  for (const [who, id, name, url, statement] of APPS) {
    const eth = await provider.getBalance(base[who].address);
    if (eth < parseUnits('0.002', 18)) {
      await baseSend(`gas for ${who}`, base.sponsor.sendTransaction({ to: base[who].address, value: parseUnits('0.004', 18) }));
    }
    if ((await token.balanceOf(base[who].address)) < DEPOSIT) {
      await baseSend(`a deposit's worth of USDC for ${who}`,
        new Contract(USDC, ERC20_ABI, base.sponsor).transfer(base[who].address, DEPOSIT));
    }
    await baseSend(`${who} approves the deposit`, new Contract(USDC, ERC20_ABI, base[who]).approve(state.escrow, DEPOSIT));
    await baseSend(`${who} stakes for application ${id}`,
      new Contract(state.escrow, artifact.abi, base[who]).depositForApplication(id));
    await glSend(who, `${who} applies: ${name}`, state.round, 'apply_to_round', [name, url, statement]);
  }
  check('both deposits are held', Number(await escrow.applicationCount()) === 2, '');
  check('the escrow holds the pot and both deposits',
    (await token.balanceOf(state.escrow)) === POT + DEPOSIT * 2n, `held ${usdc(await token.balanceOf(state.escrow))}`);
  state.applied = true; save();
}

// ---- 6. judging ------------------------------------------------------------

let round = await glRead(state.round, 'get_round');
if (round.status === 'OPEN') {
  const wait = Number(round.closes_at_epoch) - Math.floor(Date.now() / 1000) + 10;
  if (wait > 0) { console.log(`\n..  waiting ${wait}s for the deadline`); await sleep(wait); }

  for (let attempt = 1; attempt <= 12; attempt++) {
    let exec;
    try {
      exec = await glSend('sponsor', `judge_round, attempt ${attempt}`, state.round, 'judge_round', []);
    } catch (e) {
      // The consensus contract refuses submissions while the network is
      // catching up. Nothing was judged and nothing was lost, so wait longer
      // and ask again rather than giving up on a round that holds real money.
      console.log(`  ..  the network would not take it: ${String(e?.message || e).slice(0, 120)}`);
      await sleep(120);
      continue;
    }
    if (String(exec).includes('ERROR')) { console.log('a real error, stopping'); break; }
    round = await glRead(state.round, 'get_round');
    if (round.status !== 'OPEN') break;
    console.log('  ..  no vote completed, asking again in 40s');
    await sleep(40);
  }
}
const result = await glRead(state.round, 'get_result');
check('the round was judged', result.status === 'JUDGED' && result.ok === true, JSON.stringify(result).slice(0, 200));
console.log('\nthe verdict:');
for (const a of await glRead(state.round, 'get_applications')) {
  console.log(`  ${String(a.name).padEnd(24)} ${String(a.tier).padEnd(9)} ${usdc(BigInt(a.award_units))} USDC`);
}
check('the whole pot was allocated', BigInt(result.allocated_units) === POT, `allocated ${result.allocated_units}`);

// ---- 7. the verdict crosses ------------------------------------------------

console.log('\n--- the settlement crosses to Base ---');
// The bridge is shared by every round, so its pending list can hold messages
// belonging to other escrows. Only this escrow's own settlement is relevant,
// and delivering somebody else's is not a near miss: the escrow refuses it,
// which it proved by rejecting exactly that with "settlement is from another
// round" when this script was sloppier.
let mine = null;
for (let i = 0; i < 12 && !mine; i++) {
  const messages = await glRead(BRIDGE, 'get_pending');
  mine = messages.find((x) => String(x.escrow).toLowerCase() === state.escrow.toLowerCase());
  if (!mine) { console.log(`  ..  ${messages.length} pending, none for this escrow yet`); await sleep(30); }
}
check('the bridge received the settlement for this escrow', !!mine, 'nothing for this escrow after six minutes');

if (mine) {
  const m = mine;
  const payload = JSON.parse(m.payload);
  const winners = payload.winners.map((w) => w.address);
  const amounts = payload.winners.map((w) => BigInt(w.award_units));
  await baseSend('the relayer delivers the settlement',
    new Contract(state.escrow, artifact.abi, base.sponsor).processSettlement(payload.round, winners, amounts));
  check('the escrow accepted it', await escrow.settled(), '');
  await glSend('sponsor', 'record the delivery on GenLayer', BRIDGE, 'mark_delivered', [String(m.message_id), 'delivered']);
}

// ---- 8. everyone pulls what they are owed ----------------------------------

console.log('\n--- claims ---');
const before = { a: await token.balanceOf(base.alice.address), b: await token.balanceOf(base.bob.address) };
await baseSend('alice claims her award', new Contract(state.escrow, artifact.abi, base.alice).claim());
await baseSend('alice takes her deposit back', new Contract(state.escrow, artifact.abi, base.alice).claimDeposit(1));
await baseSend('bob takes his deposit back, having been declined',
  new Contract(state.escrow, artifact.abi, base.bob).claimDeposit(2));

const after = { a: await token.balanceOf(base.alice.address), b: await token.balanceOf(base.bob.address) };
check('the funded applicant received the pot and her deposit',
  after.a - before.a === POT + DEPOSIT, `moved ${usdc(after.a - before.a)}`);
check('the declined applicant got his deposit back and nothing else',
  after.b - before.b === DEPOSIT, `moved ${usdc(after.b - before.b)}`);
check('the escrow is empty', (await token.balanceOf(state.escrow)) === 0n,
  `held ${usdc(await token.balanceOf(state.escrow))}`);

console.log(`\n${passed} passed, ${failed} failed`);
console.log('round   ', state.round);
console.log('escrow  ', `https://sepolia.basescan.org/address/${state.escrow}`);
save();
process.exit(failed === 0 ? 0 : 1);
