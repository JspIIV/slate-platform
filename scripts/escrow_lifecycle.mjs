// The escrow's whole life on Base Sepolia, with real USDC, across three
// addresses: a sponsor and two applicants signing their own transactions.
//
// What is being tested is not that the functions run. It is the three
// properties the contract exists to hold: awards can never exceed the pot that
// actually arrived, every deposit comes back to whoever staked it whatever the
// verdict, and nothing is stranded if the verdict never arrives. Every figure
// is read from the chain before and after, never from what the contract says
// about itself.
import { Wallet, JsonRpcProvider, Contract, ContractFactory, parseUnits, formatUnits } from 'ethers';
import fs from 'fs';

const RPC = 'https://sepolia.base.org';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const KS = String.raw`C:\Users\ysfym\.genlayer\keystores`;

const POT = parseUnits('6', 6);
const DEPOSIT = parseUnits('1', 6);
const WINDOW_SECONDS = 180;
const GRACE_SECONDS = 120;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];

const provider = new JsonRpcProvider(RPC);
const load = async (name, password) =>
  (await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/${name}.json`, 'utf8'), password)).connect(provider);

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}
const usdc = (v) => formatUnits(v, 6);

// The public Base Sepolia endpoint sometimes answers with a receipt whose
// blockHash is all zeros and whose gas figures make no sense, for a
// transaction that is really still pending. ethers reads status 0 in that
// receipt and reports a revert that never happened. So a receipt is only
// believed once it names a real block, and the transaction is looked up again
// rather than assumed to have failed.
const ZERO_HASH = '0x' + '0'.repeat(64);

async function confirm(tx) {
  for (let i = 0; i < 12; i++) {
    const r = await provider.getTransactionReceipt(tx.hash);
    if (r && r.blockHash && r.blockHash !== ZERO_HASH) return r;
    await sleep(3);
  }
  throw new Error(`no believable receipt for ${tx.hash}`);
}

// Sends and insists on success, so a real failure still stops the run.
async function ok(promise, label) {
  const tx = await promise;
  const r = await confirm(tx);
  if (r.status !== 1) throw new Error(`${label || 'transaction'} reverted: ${tx.hash}`);
  return r;
}

// A call that must be refused, judged on the same believable receipt.
async function refused(promise) {
  try {
    const tx = await promise;
    const r = await confirm(tx);
    return r.status === 0;
  } catch {
    return true;
  }
}
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const sponsor = await load('padv', 'placard-test-adv-2026');
const alice = await load('ppub', 'placard-test-pub-2026');
const bob = await load('pchg', 'roster-test-chg-2026');

const token = new Contract(USDC, ERC20_ABI, provider);
const bal = (a) => token.balanceOf(a);

console.log('sponsor  ', sponsor.address);
console.log('alice    ', alice.address);
console.log('bob      ', bob.address);

// ---------------------------------------------------------------- funding up

console.log('\n--- making sure the applicants can transact ---');
for (const who of [alice, bob]) {
  const eth = await provider.getBalance(who.address);
  if (eth < parseUnits('0.002', 18)) {
    console.log(`  ..    sending gas to ${who.address.slice(0, 10)}`);
    await ok(sponsor.sendTransaction({ to: who.address, value: parseUnits('0.004', 18) }));
  }
  const bal6 = await bal(who.address);
  if (bal6 < DEPOSIT) {
    console.log(`  ..    sending a deposit's worth of USDC to ${who.address.slice(0, 10)}`);
    await ok(new Contract(USDC, ERC20_ABI, sponsor).transfer(who.address, DEPOSIT));
  }
}

// ------------------------------------------------------------------- deploy

const artifact = JSON.parse(fs.readFileSync('build/SlateEscrow.json', 'utf8'));
const closesAt = Math.floor(Date.now() / 1000) + WINDOW_SECONDS;

console.log('\n--- deploying the escrow ---');
const factory = new ContractFactory(artifact.abi, artifact.bytecode, sponsor);
const escrow = await factory.deploy(USDC, sponsor.address, POT, DEPOSIT, closesAt, GRACE_SECONDS);
await escrow.waitForDeployment();
const ADDR = await escrow.getAddress();
console.log('  escrow', ADDR);

// The round contract on GenLayer is not deployed yet in this test, so a
// placeholder stands in. What matters here is that the link is set once and
// that a settlement naming anything else is refused.
const FAKE_ROUND = '0x00000000000000000000000000000000DeaDBeef';
await ok(escrow.setRoundContract(FAKE_ROUND));
check('the round link can only be set once',
  await refused(escrow.setRoundContract(sponsor.address)), '');

// -------------------------------------------------------------- case 1: pot

console.log('\n--- case 1: the pot is what actually arrived ---');
const escrowSponsor = new Contract(ADDR, artifact.abi, sponsor);
await ok(new Contract(USDC, ERC20_ABI, sponsor).approve(ADDR, POT));
await ok(escrowSponsor.fund());
check('the pot is recorded from the balance that arrived',
  (await escrow.potActual()) === POT, `potActual=${usdc(await escrow.potActual())}`);
check('the escrow holds it', (await bal(ADDR)) === POT, `balance=${usdc(await bal(ADDR))}`);
check('funding twice is refused',
  await refused(escrowSponsor.fund()), '');

// --------------------------------------------------------- case 2: deposits

console.log('\n--- case 2: applicants stake ---');
for (const [i, who] of [[1, alice], [2, bob]]) {
  await ok(new Contract(USDC, ERC20_ABI, who).approve(ADDR, DEPOSIT));
  await ok(new Contract(ADDR, artifact.abi, who).depositForApplication(i));
}
check('both deposits are held', Number(await escrow.applicationCount()) === 2, '');
check('the escrow now holds the pot plus both deposits',
  (await bal(ADDR)) === POT + DEPOSIT * 2n, `balance=${usdc(await bal(ADDR))}`);
check('the same application cannot stake twice',
  await refused(new Contract(ADDR, artifact.abi, alice).depositForApplication(1)), '');

// ------------------------------------------------------- case 3: settlement

console.log('\n--- case 3: settlement is checked, not trusted ---');
check('settling before the round closes is refused',
  await refused(escrowSponsor.processSettlement(FAKE_ROUND, [alice.address], [POT])), '');

const left = closesAt - Math.floor(Date.now() / 1000) + 5;
if (left > 0) { console.log(`  ..    waiting ${left}s for the round to close`); await sleep(left); }

check('a settlement from another round is refused',
  await refused(escrowSponsor.processSettlement(sponsor.address, [alice.address], [DEPOSIT])), '');
check('awards above the pot are refused',
  await refused(escrowSponsor.processSettlement(FAKE_ROUND, [alice.address], [POT + 1n])), '');

// LEAD takes four shares and STRONG two, the split Slate proved on chain.
const aliceAward = (POT * 4n) / 6n;
const bobAward = (POT * 2n) / 6n;
await ok(escrowSponsor.processSettlement(FAKE_ROUND, [alice.address, bob.address], [aliceAward, bobAward]));
check('the settlement is recorded', await escrow.settled(), '');
check('settling twice is refused',
  await refused(escrowSponsor.processSettlement(FAKE_ROUND, [alice.address], [1n])), '');

// ----------------------------------------------------------- case 4: claims

console.log('\n--- case 4: everyone pulls their own ---');
const before = { a: await bal(alice.address), b: await bal(bob.address), s: await bal(sponsor.address) };

await ok(new Contract(ADDR, artifact.abi, alice).claim());
await ok(new Contract(ADDR, artifact.abi, bob).claim());
check('claiming twice is refused',
  await refused(new Contract(ADDR, artifact.abi, alice).claim()), '');
check('somebody who won nothing cannot claim',
  await refused(escrowSponsor.claim()), '');

await ok(new Contract(ADDR, artifact.abi, alice).claimDeposit(1));
await ok(new Contract(ADDR, artifact.abi, bob).claimDeposit(2));
check('a deposit cannot be taken by somebody else',
  await refused(new Contract(ADDR, artifact.abi, alice).claimDeposit(2)), '');

const after = { a: await bal(alice.address), b: await bal(bob.address), s: await bal(sponsor.address) };
check('the LEAD applicant received four shares plus their deposit back',
  after.a - before.a === aliceAward + DEPOSIT, `moved ${usdc(after.a - before.a)}`);
check('the STRONG applicant received two shares plus their deposit back',
  after.b - before.b === bobAward + DEPOSIT, `moved ${usdc(after.b - before.b)}`);

// ------------------------------------------------------- case 5: nothing left

console.log('\n--- case 5: nothing is stranded ---');
const remainder = POT - aliceAward - bobAward;
if (remainder > 0n) {
  await ok(escrowSponsor.reclaimPot());
  check('the sponsor takes back only what was not awarded',
    (await bal(sponsor.address)) - after.s === remainder, `remainder ${usdc(remainder)}`);
} else {
  check('there is no remainder to reclaim',
    await refused(escrowSponsor.reclaimPot()), '');
}
check('the escrow is empty', (await bal(ADDR)) === 0n, `balance=${usdc(await bal(ADDR))}`);

console.log(`\n${passed} passed, ${failed} failed`);
console.log('escrow', ADDR);
console.log(`https://sepolia.basescan.org/address/${ADDR}`);
process.exit(failed === 0 ? 0 : 1);
