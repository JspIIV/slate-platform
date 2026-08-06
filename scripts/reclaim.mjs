// Gets the money out of rounds that never reached a verdict.
//
// This is the escape hatch working in the open. Two rounds were left funded
// when the network stopped finalising: no judgement arrived, so after the grace
// period the escrow lets the sponsor take the pot back and every applicant take
// their own deposit. Nothing here needs the relayer, the bridge, or GenLayer to
// be healthy, which is the whole point of putting the money on the other chain.
import { Wallet, JsonRpcProvider, Contract, formatUnits } from 'ethers';
import fs from 'fs';

const BASE_RPC = 'https://sepolia.base.org';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const KS = String.raw`C:\Users\ysfym\.genlayer\keystores`;
const ZERO_HASH = '0x' + '0'.repeat(64);

const ESCROWS = process.argv.slice(2);
if (ESCROWS.length === 0) {
  console.error('pass one or more escrow addresses');
  process.exit(1);
}

const artifact = JSON.parse(fs.readFileSync('build/SlateEscrow.json', 'utf8'));
const provider = new JsonRpcProvider(BASE_RPC);
const load = async (name, pass) =>
  (await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/${name}.json`, 'utf8'), pass)).connect(provider);

const people = {
  sponsor: await load('padv', 'placard-test-adv-2026'),
  alice: await load('ppub', 'placard-test-pub-2026'),
  bob: await load('pchg', 'roster-test-chg-2026'),
};
const token = new Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
const usdc = (v) => formatUnits(v, 6);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function confirm(tx) {
  for (let i = 0; i < 15; i++) {
    const r = await provider.getTransactionReceipt(tx.hash);
    if (r && r.blockHash && r.blockHash !== ZERO_HASH) return r;
    await sleep(3);
  }
  throw new Error(`no believable receipt for ${tx.hash}`);
}

async function tryIt(label, promise) {
  try {
    const tx = await promise;
    const r = await confirm(tx);
    console.log(`  ${r.status === 1 ? 'done ' : 'FAILED'} ${label}  ${tx.hash}`);
  } catch (e) {
    // A refusal here is usually correct: nothing owed, or already taken. It is
    // reported rather than swallowed, but it does not stop the sweep.
    console.log(`  skip  ${label}: ${String(e?.shortMessage || e?.message || e).slice(0, 90)}`);
  }
}

for (const address of ESCROWS) {
  const escrow = new Contract(address, artifact.abi, provider);
  const held = await token.balanceOf(address);
  console.log(`\nescrow ${address} holds ${usdc(held)} USDC`);
  if (held === 0n) continue;

  const status = await escrow.status();
  console.log(`  funded=${status[0]} settled=${status[1]} applications=${status[4]} graceEndsIn=${status[7]}s`);

  for (const [who, wallet] of Object.entries(people)) {
    for (const id of [1, 2, 3]) {
      const staker = await escrow.applicant(id);
      if (staker.toLowerCase() !== wallet.address.toLowerCase()) continue;
      if (!(await escrow.depositHeld(id))) continue;
      await tryIt(`${who} takes back the deposit for application ${id}`,
        new Contract(address, artifact.abi, wallet).claimDeposit(id));
    }
  }

  await tryIt('the sponsor reclaims the unawarded pot',
    new Contract(address, artifact.abi, people.sponsor).reclaimPot());

  console.log(`  now holds ${usdc(await token.balanceOf(address))} USDC`);
}

console.log('\nbalances after the sweep');
for (const [who, wallet] of Object.entries(people)) {
  console.log('  ', who.padEnd(8), usdc(await token.balanceOf(wallet.address)), 'USDC');
}
