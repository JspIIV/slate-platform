// Compiles the escrow with solc and writes the artifact next to it.
import solc from 'solc';
import fs from 'fs';
import path from 'path';

const name = process.argv[2] || 'SlateEscrow';
const source = fs.readFileSync(`contracts/${name}.sol`, 'utf8');

const input = {
  language: 'Solidity',
  sources: { [`${name}.sol`]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) console.log(`[${e.severity}] ${e.formattedMessage.trim()}`);
if (errors.length) process.exit(1);

const c = out.contracts[`${name}.sol`][name];
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync(`build/${name}.json`, JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2));
console.log(`compiled ${name}: ${c.abi.length} abi entries, ${c.evm.bytecode.object.length / 2} bytes`);
