import { Wallet, JsonRpcProvider, Contract, ContractFactory, parseUnits } from 'ethers';
import fs from 'fs';
const RPC = process.env.RPC || 'https://sepolia.base.org';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const KS = String.raw`C:\Users\ysfym\.genlayer\keystores`;
const provider = new JsonRpcProvider(RPC);
const sponsor = (await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/padv.json`, 'utf8'), 'placard-test-adv-2026')).connect(provider);
const art = JSON.parse(fs.readFileSync('build/SlateEscrow.json', 'utf8'));

console.log('rpc', RPC, 'block', await provider.getBlockNumber());
const closesAt = Math.floor(Date.now() / 1000) + 600;
const f = new ContractFactory(art.abi, art.bytecode, sponsor);
const e = await f.deploy(USDC, sponsor.address, parseUnits('6', 6), parseUnits('1', 6), closesAt, 120);
const dtx = e.deploymentTransaction();
console.log('deploy tx', dtx.hash);
await e.waitForDeployment();
const addr = await e.getAddress();
const code = await provider.getCode(addr);
console.log('address', addr, 'code bytes', (code.length - 2) / 2);
console.log('owner()', await e.owner());

const ROUND = '0x00000000000000000000000000000000deadbeef';
const data = e.interface.encodeFunctionData('setRoundContract', [ROUND]);
console.log('encoded calldata', data.slice(0, 20), 'len', data.length);
const tx = await e.setRoundContract(ROUND);
console.log('sent', tx.hash, 'data on tx:', (tx.data || '').slice(0, 20), 'len', (tx.data || '').length);
const r = await tx.wait();
console.log('status', r.status, 'gasUsed', r.gasUsed.toString());
console.log('roundContract()', await e.roundContract());
