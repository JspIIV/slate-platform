// The backend. Two write endpoints, and nothing else, because every extra one
// is another thing a user has to trust.
//
// Opening a round means deploying two contracts on two chains and linking them,
// which no single wallet transaction can do and which the chain cannot do for
// itself: `gl.deploy_contract` returns an address where no contract ever
// appears on this network, measured and reported as genvm-manager#20. So a
// deployer key does it.
//
// What that key can and cannot do is worth being exact about, because it is the
// centralised part of an otherwise trustless design:
//
//   it cannot take the money      the escrow only ever pays the winners a
//                                 settlement names, and the sponsor
//   it cannot invent a winner     the escrow accepts a settlement only from the
//                                 round address it was linked to at deployment
//   it cannot inflate an award    the escrow refuses a total above the pot it
//                                 actually holds
//   it cannot stall a round       if it never relays, the escrow's grace period
//                                 returns the pot and every deposit
//
// The sponsor funds the escrow themselves, from their own wallet, so the money
// never passes through here.
import express from 'express';
import cors from 'cors';
import { Wallet, JsonRpcProvider, Contract, ContractFactory, parseUnits } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const BASE_RPC = process.env.BASE_RPC || 'https://sepolia.base.org';
const USDC = process.env.USDC || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN_ID = 84532;
const REGISTRY = process.env.REGISTRY;
const BRIDGE = process.env.BRIDGE;
const GRACE_SECONDS = Number(process.env.GRACE_SECONDS || 1800);

// The deployer key comes either from a file on a developer's machine or, when
// hosted, from an environment variable holding the same encrypted keystore. It
// is never in the repository either way.
const KEYSTORE = process.env.KEYSTORE;
const KEYSTORE_JSON = process.env.KEYSTORE_JSON;
const KEY_PASS = process.env.KEY_PASS;

if (!REGISTRY || !BRIDGE || (!KEYSTORE && !KEYSTORE_JSON)) {
  console.error('REGISTRY, BRIDGE and either KEYSTORE or KEYSTORE_JSON are required');
  process.exit(1);
}

const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, 'build/SlateEscrow.json'), 'utf8'));
const roundSource = fs.readFileSync(path.join(__dirname, 'contracts/slate_round.py'));

const provider = new JsonRpcProvider(BASE_RPC);
const keystoreJson = KEYSTORE_JSON || fs.readFileSync(KEYSTORE, 'utf8');
const deployer = (await Wallet.fromEncryptedJson(keystoreJson, KEY_PASS)).connect(provider);
const gen = createClient({ chain: testnetAsimov, account: createAccount(deployer.privateKey) });
const genReader = createClient({ chain: testnetAsimov });

const ZERO_HASH = '0x' + '0'.repeat(64);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const transient = (e) => /backpressure|not currently accepting|was reverted|fetch failed|ECONNRESET|socket|timeout|Server busy|Rate limit|-32006|-32029|-32603/i
  .test(String(e?.details || e?.message || e));

async function retry(label, fn, attempts = 5) {
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

// The public Base endpoint sometimes hands back a receipt with a zeroed block
// hash for a transaction that is still pending, whose status field then looks
// like a revert that never happened. A receipt counts only once it names a
// block. Without this a settlement would be retried after it had landed.
async function confirm(tx) {
  for (let i = 0; i < 20; i++) {
    const r = await provider.getTransactionReceipt(tx.hash);
    if (r && r.blockHash && r.blockHash !== ZERO_HASH) return r;
    await sleep(3);
  }
  throw new Error(`no believable receipt for ${tx.hash}`);
}

const glRead = async (address, functionName, args = []) => {
  const raw = await retry(`read ${functionName}`, () => genReader.readContract({ address, functionName, args }));
  try { return JSON.parse(raw); } catch { return raw; }
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({
    registry: REGISTRY,
    bridge: BRIDGE,
    usdc: USDC,
    settlement_chain_id: CHAIN_ID,
    settlement_chain_name: 'Base Sepolia',
    genlayer_rpc: 'https://rpc-asimov.genlayer.com',
    base_rpc: BASE_RPC,
    deployer: deployer.address,
    grace_seconds: GRACE_SECONDS,
    escrow_abi: artifact.abi,
  });
});

// Opening a round costs this server gas on two chains, so a public instance
// needs a limit that a laptop does not. It is deliberately crude: enough to
// stop a loop from draining the deployer, not enough to get in a visitor's way.
const OPEN_LIMIT_PER_HOUR = Number(process.env.OPEN_LIMIT_PER_HOUR || 6);
const opened = [];

function withinLimit() {
  const hourAgo = Date.now() - 3600_000;
  while (opened.length && opened[0] < hourAgo) opened.shift();
  if (opened.length >= OPEN_LIMIT_PER_HOUR) return false;
  opened.push(Date.now());
  return true;
}

/// Opens a round: an escrow on Base, a round on GenLayer, and the link between
/// them. The sponsor funds it afterwards from their own wallet.
app.post('/api/rounds', async (req, res) => {
  try {
    if (!withinLimit()) {
      return res.status(429).json({
        error: `This instance opens at most ${OPEN_LIMIT_PER_HOUR} rounds an hour, `
          + 'because each one costs it gas on two testnets. Try again shortly, '
          + 'or run your own copy from the repository.',
      });
    }
    const { sponsor, title, purpose, criteria, pot_usdc, deposit_usdc, window_seconds, max_applications } = req.body || {};

    const fail = (message) => res.status(400).json({ error: message });
    if (!sponsor || !/^0x[0-9a-fA-F]{40}$/.test(sponsor)) return fail('a sponsor address is required');
    if (!title || title.trim().length < 4) return fail('a title is required');
    if (!purpose || purpose.trim().length < 20) return fail('say what the round is for, in a sentence or two');
    if (!criteria || criteria.trim().length < 60) return fail('the criteria have to be specific enough to judge against');
    const pot = Number(pot_usdc);
    const deposit = Number(deposit_usdc);
    const windowSeconds = Number(window_seconds);
    const maxApplications = Number(max_applications || 5);
    if (!(pot > 0)) return fail('the pot has to be more than nothing');
    if (!(deposit >= 0)) return fail('the deposit cannot be negative');
    if (!(windowSeconds >= 600)) return fail('give applicants at least ten minutes');
    if (!(maxApplications >= 1 && maxApplications <= 20)) return fail('between one and twenty applications');

    const potUnits = parseUnits(String(pot), 6);
    const depositUnits = parseUnits(String(deposit), 6);
    const closesAt = Math.floor(Date.now() / 1000) + windowSeconds;

    console.log(`\nopening a round for ${sponsor}: ${title}`);

    const factory = new ContractFactory(artifact.abi, artifact.bytecode, deployer);
    const escrow = await factory.deploy(USDC, sponsor, potUnits, depositUnits, closesAt, GRACE_SECONDS);
    await escrow.waitForDeployment();
    const escrowAddress = await escrow.getAddress();
    console.log('  escrow', escrowAddress);

    const deployHash = await retry('deploy round', () => gen.deployContract({
      code: roundSource,
      args: [
        REGISTRY, BRIDGE, escrowAddress, String(CHAIN_ID), sponsor,
        title.trim(), purpose.trim(), criteria.trim(),
        potUnits.toString(), depositUnits.toString(), String(closesAt), String(maxApplications),
      ],
      leaderOnly: false,
    }));
    const receipt = await retry('round receipt', () => genReader.getTransaction({ hash: deployHash }));
    const parsed = JSON.parse(JSON.stringify(receipt, (k, v) => typeof v === 'bigint' ? v.toString() : v));
    const roundAddress = parsed.data?.contract_address || parsed.recipient;
    if (!roundAddress) throw new Error('the round deployed but did not report an address');
    console.log('  round ', roundAddress);

    await confirm(await escrow.setRoundContract(roundAddress));

    const recordHash = await retry('record round', () => gen.writeContract({
      address: REGISTRY,
      functionName: 'record_round',
      args: [roundAddress, escrowAddress, String(CHAIN_ID), sponsor, title.trim(), purpose.trim(),
             potUnits.toString(), depositUnits.toString(), String(closesAt)],
      value: 0n,
    }));
    await retry('record receipt', () => gen.waitForTransactionReceipt({
      hash: recordHash, status: 'ACCEPTED', retries: 120, interval: 10000 }));

    res.json({
      round: roundAddress,
      escrow: escrowAddress,
      closes_at_epoch: closesAt,
      pot_units: potUnits.toString(),
      deposit_units: depositUnits.toString(),
      next: 'the sponsor now approves the pot and calls fund() on the escrow',
    });
  } catch (e) {
    console.error('opening the round failed:', e);
    res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
});

/// Relays whatever settlements are waiting. Delivery only: it can carry a
/// verdict that already exists on GenLayer and nothing else.
app.post('/api/relay', async (_req, res) => {
  try {
    const pending = await glRead(BRIDGE, 'get_pending');
    const delivered = [];
    const skipped = [];

    for (const message of pending) {
      const payload = JSON.parse(message.payload);
      const escrow = new Contract(message.escrow, artifact.abi, deployer);

      const linked = (await escrow.roundContract()).toLowerCase();
      if (linked !== String(payload.round).toLowerCase()) {
        skipped.push({ message_id: message.message_id, why: 'that escrow is linked to a different round' });
        continue;
      }
      if (await escrow.settled()) {
        skipped.push({ message_id: message.message_id, why: 'already settled' });
        continue;
      }

      const winners = payload.winners.map((w) => w.address);
      const amounts = payload.winners.map((w) => BigInt(w.award_units));
      const tx = await escrow.processSettlement(payload.round, winners, amounts);
      const receipt = await confirm(tx);
      if (receipt.status !== 1) {
        skipped.push({ message_id: message.message_id, why: 'the escrow refused it' });
        continue;
      }

      const markHash = await retry('mark delivered', () => gen.writeContract({
        address: BRIDGE, functionName: 'mark_delivered',
        args: [String(message.message_id), tx.hash], value: 0n }));
      await retry('mark receipt', () => gen.waitForTransactionReceipt({
        hash: markHash, status: 'ACCEPTED', retries: 120, interval: 10000 }));

      delivered.push({ message_id: message.message_id, escrow: message.escrow, tx: tx.hash });
    }

    res.json({ pending: pending.length, delivered, skipped });
  } catch (e) {
    console.error('relaying failed:', e);
    res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
});

/// Everything the catalogue knows, in one read, so the app can paint a page
/// without a dozen round trips.
app.get('/api/rounds', async (_req, res) => {
  try {
    res.json(await glRead(REGISTRY, 'get_frontend_bootstrap'));
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e).slice(0, 200) });
  }
});

app.get('/api/rounds/:address', async (req, res) => {
  try {
    const address = req.params.address;
    const [round, applications, result, audit] = await Promise.all([
      glRead(address, 'get_round'),
      glRead(address, 'get_applications'),
      glRead(address, 'get_result'),
      glRead(address, 'get_audit_trail'),
    ]);
    res.json({ round, applications, result, audit });
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e).slice(0, 200) });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, deployer: deployer.address }));

// A wallet for driving the app where no browser extension exists, enabled only
// when DEV_WALLET is set. It signs with the project's own test keys against the
// real networks, so what it exercises is the real write path rather than a
// stand in for it. A deployed instance simply does not switch it on.
if (process.env.DEV_WALLET === '1') {
  const dev = await import('./dev-wallet.mjs');
  app.get('/dev/wallet.js', (_req, res) => {
    res.type('application/javascript').send(dev.injectedScript());
  });
  app.get('/dev/accounts', (_req, res) => res.json(dev.accountAddresses()));
  app.post('/dev/rpc', async (req, res) => {
    try {
      const { who, chainId, method, params } = req.body || {};
      const result = await dev.handle(who, { method, params, chainId });
      if (method === 'eth_sendTransaction') {
        console.log(`dev wallet: ${who} sent on ${chainId} to ${params?.[0]?.to} -> ${result}`);
      }
      res.json({ result });
    } catch (e) {
      console.error('dev wallet:', req.body?.method, 'on', req.body?.chainId, '->',
        String(e?.shortMessage || e?.message || e).slice(0, 400));
      res.status(500).json({ error: String(e?.shortMessage || e?.message || e).slice(0, 300) });
    }
  });
  console.log('  dev wallet enabled at /dev/wallet.js');
}

// Hosted, the platform exports a handler and something else does the listening.
// Run directly, it listens itself. The same file serves both so there is only
// one thing to keep correct.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`slate platform on http://localhost:${PORT}`);
    console.log('  registry', REGISTRY);
    console.log('  bridge  ', BRIDGE);
    console.log('  deployer', deployer.address);
  });
}

export default app;
