import { createClient } from '../../colophon-app/node_modules/genlayer-js/dist/index.js';
import { testnetAsimov } from '../../colophon-app/node_modules/genlayer-js/dist/chains/index.js';
const c = createClient({ chain: testnetAsimov });
const read = async (a, fn, args = []) => JSON.parse(await c.readContract({ address: a, functionName: fn, args }));
const REG = '0xD3C7d3E242b0F5F307507d42952a1d756D0103b3';
console.log('stats', JSON.stringify(await read(REG, 'get_stats')));
for (const r of await read(REG, 'get_recent_rounds', ['5'])) {
  console.log(`  ${r.round_id} ${r.round_contract.slice(0,10)}… status=${r.status} funded=${r.funded_count} allocated=${r.allocated_units}`);
}
