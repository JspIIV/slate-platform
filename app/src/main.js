// The app. Four screens: the rounds, opening one, a round's own page, and what
// you are owed.
//
// Two things it refuses to do. It never computes a figure the chains can be
// asked for, so nothing on screen can drift from what settlement will actually
// do. And it never asks the user which network to be on: each action switches
// the wallet itself, because a person applying to a grant round should not have
// to know that the deposit is on one chain and the record is on another.
import './style.css';
import {
  loadConfig, connect, currentAccount, shortAddr, usdc, toUnits,
  genRead, genWrite, baseSend, baseRead, ERC20_ABI,
} from './chain.js';

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let config = null;
let view = 'rounds';
let viewArg = null;

// ------------------------------------------------------------------ shell

function shell() {
  document.body.innerHTML = `
    <header>
      <div class="brand" data-go="rounds">Slate</div>
      <nav>
        <button data-go="rounds">Rounds</button>
        <button data-go="open">Open a round</button>
      </nav>
      <button id="connect" class="wallet">Connect</button>
    </header>
    <main id="view"></main>
    <footer>
      <span>Judged on GenLayer, settled in USDC on Base Sepolia.</span>
      <span id="addresses"></span>
    </footer>`;

  document.body.onclick = (e) => {
    const go = e.target.closest('[data-go]');
    if (!go) return;
    view = go.dataset.go;
    viewArg = go.dataset.arg || null;
    render();
  };
  el('connect').onclick = async () => {
    try { await connect(); paintWallet(); render(); }
    catch (err) { alert(err.message); }
  };
}

function paintWallet() {
  const account = currentAccount();
  el('connect').textContent = account ? shortAddr(account) : 'Connect';
  el('connect').classList.toggle('on', !!account);
}

const busy = (what) => `<div class="busy">${esc(what)}…</div>`;
const walletBanner = () => (currentAccount() ? '' :
  `<div class="banner">Connect a wallet to take part. Reading needs nothing.</div>`);

// An approval and the call that spends it are two transactions, and the second
// one estimates its gas against whatever state the node it lands on can see.
// That node is not always the one that mined the first, so a spend sent the
// instant an approval is mined fails with "missing revert data", which says
// nothing about allowances at all. So the allowance is read back until it is
// really there before anything tries to spend it.
async function allowanceReady(owner, spender, needed) {
  for (let i = 0; i < 20; i++) {
    const allowance = await baseRead(config.usdc, ERC20_ABI, 'allowance', [owner, spender]);
    if (allowance >= needed) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('The approval did not show up on chain. Try the button again in a moment.');
}

// A place for feedback that is next to the button that caused it, rather than
// at the bottom of a page the user cannot see.
async function act(button, work, done) {
  const row = button.closest('.row') || button.parentElement;
  let note = row.querySelector('.note');
  if (!note) { note = document.createElement('div'); note.className = 'note'; row.appendChild(note); }
  button.disabled = true;
  note.textContent = 'Working. A GenLayer transaction takes a couple of minutes.';
  note.className = 'note working';
  note.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  try {
    const result = await work();
    note.textContent = typeof done === 'function' ? done(result) : done;
    note.className = 'note ok';
    return result;
  } catch (err) {
    note.textContent = String(err?.shortMessage || err?.message || err).slice(0, 300);
    note.className = 'note bad';
    throw err;
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------ the catalogue

async function viewRounds() {
  el('view').innerHTML = `<h1>Funding rounds</h1>${busy('Reading the catalogue')}`;
  const data = await (await fetch('/api/rounds')).json();
  const rounds = data.rounds || [];
  const now = Math.floor(Date.now() / 1000);

  el('view').innerHTML = `
    <h1>Funding rounds</h1>
    <p class="lede">A sponsor puts up USDC and writes what they want to fund in
    plain words. Anyone applies by staking a deposit and citing a page. When the
    deadline passes, GenLayer validators read every application together and
    place each in a tier, and the money follows those tiers.</p>
    ${rounds.length === 0 ? `<div class="empty">No rounds yet. <a href="#" data-go="open">Open the first one.</a></div>` : ''}
    <div class="grid">
      ${rounds.slice().reverse().map((r) => {
        const closed = Number(r.closes_at_epoch) <= now;
        return `
        <article class="card" data-go="round" data-arg="${esc(r.round_contract)}">
          <div class="tag ${r.status === 'OPEN' ? (closed ? 'closing' : 'open') : 'done'}">
            ${r.status === 'OPEN' ? (closed ? 'awaiting judgement' : 'open') : esc(r.status.toLowerCase())}
          </div>
          <h3>${esc(r.title)}</h3>
          <p>${esc(r.purpose)}</p>
          <div class="figures">
            <span><b>${usdc(r.pot_units)}</b> USDC pot</span>
            <span><b>${usdc(r.deposit_units)}</b> deposit</span>
          </div>
        </article>`;
      }).join('')}
    </div>`;
}

// ------------------------------------------------------------ opening a round

function viewOpen() {
  el('view').innerHTML = `
    <h1>Open a round</h1>
    ${walletBanner()}
    <p class="lede">Two contracts are deployed for you, one on each chain, and
    linked to each other. You then fund the pot yourself, from your own wallet:
    the money never passes through this server.</p>
    <div class="form">
      <label>Title<input id="f-title" placeholder="Open source developer tooling grant" /></label>
      <label>What the round is for
        <textarea id="f-purpose" rows="2" placeholder="Fund small teams building tooling other developers can adopt"></textarea></label>
      <label>What it funds, in enough detail to judge against
        <textarea id="f-criteria" rows="5" placeholder="The applicant must show a real, working tool on a page they publish, with documentation a stranger could follow…"></textarea></label>
      <div class="pair">
        <label>Pot, USDC<input id="f-pot" type="number" min="0.1" step="0.1" value="6" /></label>
        <label>Deposit per application, USDC<input id="f-deposit" type="number" min="0" step="0.1" value="1" /></label>
      </div>
      <div class="pair">
        <label>Open for, minutes<input id="f-window" type="number" min="10" value="30" /></label>
        <label>Most applications<input id="f-max" type="number" min="1" max="20" value="5" /></label>
      </div>
      <div class="row"><button id="f-open" class="act">Deploy the round</button></div>
    </div>`;

  el('f-open').onclick = (e) => act(e.target, async () => {
    if (!currentAccount()) throw new Error('Connect a wallet first: the round is opened in your name.');
    const body = {
      sponsor: currentAccount(),
      title: el('f-title').value.trim(),
      purpose: el('f-purpose').value.trim(),
      criteria: el('f-criteria').value.trim(),
      pot_usdc: el('f-pot').value,
      deposit_usdc: el('f-deposit').value,
      window_seconds: Number(el('f-window').value) * 60,
      max_applications: Number(el('f-max').value),
    };
    const res = await fetch('/api/rounds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'the round could not be opened');
    viewArg = out.round; view = 'round';
    setTimeout(render, 1200);
    return out;
  }, (out) => `Deployed. Round ${shortAddr(out.round)}, escrow ${shortAddr(out.escrow)}. Fund the pot next.`);
}

// -------------------------------------------------------------- one round

async function viewRound() {
  const address = viewArg;
  el('view').innerHTML = `<h1>Round</h1>${busy('Reading both chains')}`;

  const data = await (await fetch(`/api/rounds/${address}`)).json();
  const { round, applications, result } = data;
  const now = Math.floor(Date.now() / 1000);
  const closesIn = Number(round.closes_at_epoch) - now;
  const judged = round.status !== 'OPEN';
  const me = (currentAccount() || '').toLowerCase();

  let escrowStatus = null;
  try {
    if (window.ethereum) {
      const s = await baseRead(round.escrow, config.escrow_abi, 'status');
      escrowStatus = {
        funded: s[0], settled: s[1], pot: s[2], awarded: s[3],
        applications: Number(s[4]), balance: s[5],
      };
    }
  } catch { /* the escrow is readable without a wallet only if one is present */ }

  const mine = applications.find((a) => a.applicant === me);

  el('view').innerHTML = `
    <a class="back" href="#" data-go="rounds">All rounds</a>
    <h1>${esc(round.title)}</h1>
    <p class="lede">${esc(round.purpose)}</p>
    ${walletBanner()}

    <div class="strip">
      <div><span>Pot</span><b>${usdc(round.pot_units)} USDC</b></div>
      <div><span>Deposit</span><b>${usdc(round.deposit_units)} USDC</b></div>
      <div><span>Status</span><b>${judged ? esc(round.status.toLowerCase())
        : closesIn > 0 ? `open, ${Math.ceil(closesIn / 60)} min left` : 'awaiting judgement'}</b></div>
      <div><span>Applications</span><b>${applications.length}</b></div>
    </div>

    <details class="criteria"><summary>What this round funds</summary><p>${esc(round.criteria)}</p></details>

    <h2>Applications</h2>
    ${applications.length === 0 ? `<div class="empty">Nobody has applied yet.</div>` : `
    <table>
      <thead><tr><th>Applicant</th><th>Page</th><th>Tier</th><th>Award</th></tr></thead>
      <tbody>
        ${applications.map((a) => `
          <tr class="${a.status === 'WITHDRAWN' ? 'gone' : ''}">
            <td>
              <b>${esc(a.name)}</b>
              <div class="mono">${esc(shortAddr(a.applicant))}${a.applicant === me ? ' · you' : ''}</div>
              ${a.reason ? `<div class="reason">${esc(a.reason)}</div>` : ''}
            </td>
            <td><a href="${esc(a.subject_url)}" target="_blank" rel="noreferrer">cited page</a></td>
            <td>${a.tier ? `<span class="tier ${esc(a.tier.toLowerCase())}">${esc(a.tier)}</span>` : '—'}</td>
            <td>${a.award_units && a.award_units !== '0' ? `${usdc(a.award_units)} USDC` : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`}

    ${!judged && escrowStatus && !escrowStatus.funded && round.sponsor === me ? `
      <h2>Fund the pot</h2>
      <p class="fine">Nobody can apply until the money is there. Two signatures on Base Sepolia:
      one to let the escrow move ${usdc(round.pot_units)} USDC, one to move it.</p>
      <div class="row"><button id="fund" class="act">Approve and fund ${usdc(round.pot_units)} USDC</button></div>` : ''}

    ${!judged && escrowStatus && !escrowStatus.funded && round.sponsor !== me ? `
      <div class="banner">This round is not funded yet, so applications are closed until the sponsor funds it.</div>` : ''}

    ${!judged && closesIn > 0 && !mine && escrowStatus && escrowStatus.funded ? `
      <h2>Apply</h2>
      <div class="form">
        <label>What you built<input id="a-name" placeholder="Ripgrep" /></label>
        <label>A page that shows it<input id="a-url" placeholder="https://github.com/…" /></label>
        <label>Why it fits<textarea id="a-statement" rows="3"></textarea></label>
        <div class="row"><button id="a-go" class="act">Stake ${usdc(round.deposit_units)} USDC and apply</button></div>
        <p class="fine">Two signatures: the deposit on Base Sepolia, then the application on GenLayer.
        Your wallet switches networks between them.</p>
      </div>` : ''}

    ${!judged && closesIn <= 0 ? `
      <div class="row"><button id="judge" class="act">Run the judgement</button></div>
      <p class="fine">Anyone may start it. Validators read every cited page and rule on all the
      applications together.</p>` : ''}

    ${judged ? `
      <h2>Settlement</h2>
      <div class="row">
        <button id="relay" class="ghost">Deliver the verdict to Base</button>
        <button id="claim" class="act">Claim what I am owed</button>
        <button id="deposit-back" class="ghost">Take my deposit back</button>
      </div>
      ${escrowStatus ? `<p class="fine">The escrow holds ${usdc(escrowStatus.balance)} USDC and
        ${escrowStatus.settled ? 'has the verdict' : 'is still waiting for the verdict'}.</p>` : ''}` : ''}

    <p class="fine mono">
      round ${esc(round.round_contract || address)} on GenLayer ·
      <a href="https://sepolia.basescan.org/address/${esc(round.escrow)}" target="_blank" rel="noreferrer">escrow on Base</a>
    </p>`;

  if (el('fund')) {
    el('fund').onclick = (e) => act(e.target, async () => {
      const pot = BigInt(round.pot_units);
      const allowance = await baseRead(config.usdc, ERC20_ABI, 'allowance', [currentAccount(), round.escrow]);
      if (allowance < pot) {
        await baseSend(config.usdc, ERC20_ABI, 'approve', [round.escrow, pot]);
        await allowanceReady(currentAccount(), round.escrow, pot);
      }
      await baseSend(round.escrow, config.escrow_abi, 'fund', []);
      setTimeout(render, 1500);
    }, 'Funded. The escrow holds the pot and applications are open.');
  }

  if (el('a-go')) {
    el('a-go').onclick = (e) => act(e.target, async () => {
      const name = el('a-name').value.trim();
      const url = el('a-url').value.trim();
      const statement = el('a-statement').value.trim();
      if (!name) throw new Error('Say what you built.');
      if (!/^https?:\/\//.test(url)) throw new Error('Cite a page starting with http or https.');
      if (statement.length < 20) throw new Error('A sentence or two on why it fits, please.');

      const applicationId = applications.length + 1;
      const deposit = BigInt(round.deposit_units);
      // Applying touches two chains, so it can be interrupted between them and
      // leave a deposit staked with no application behind it. Rather than
      // refusing the second attempt, or worse taking a second deposit, the
      // stake already held for this id is recognised and the flow carries on
      // from where it stopped.
      const alreadyStaked = (await baseRead(round.escrow, config.escrow_abi, 'applicant', [applicationId]))
        .toLowerCase() === currentAccount().toLowerCase();

      if (deposit > 0n && !alreadyStaked) {
        const allowance = await baseRead(config.usdc, ERC20_ABI, 'allowance', [currentAccount(), round.escrow]);
        if (allowance < deposit) {
          await baseSend(config.usdc, ERC20_ABI, 'approve', [round.escrow, deposit]);
          await allowanceReady(currentAccount(), round.escrow, deposit);
        }
        await baseSend(round.escrow, config.escrow_abi, 'depositForApplication', [applicationId]);
      }
      // Confirmed by the round itself listing the application, not by a
      // receipt. The deposit is already staked at this point, so a false
      // failure here would be the worst possible message to show.
      await genWrite(address, 'apply_to_round', [name, url, statement], async () => {
        const rows = await genRead(address, 'get_applications');
        return rows.some((r) => r.applicant === currentAccount().toLowerCase() && r.status === 'SUBMITTED');
      });
      setTimeout(render, 1500);
    }, 'Applied. Your deposit is held on Base and your application is recorded on GenLayer.');
  }

  if (el('judge')) {
    el('judge').onclick = (e) => act(e.target, async () => {
      await genWrite(address, 'judge_round', [], async () => {
        const r = await genRead(address, 'get_round');
        return r.status !== 'OPEN';
      });
      setTimeout(render, 1500);
    }, 'Judged. The verdict is on GenLayer and can now be delivered to the escrow.');
  }

  if (el('relay')) {
    el('relay').onclick = (e) => act(e.target, async () => {
      const res = await fetch('/api/relay', { method: 'POST' });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'the settlement could not be delivered');
      setTimeout(render, 1500);
      return out;
    }, (out) => (out.delivered.length
      ? `Delivered ${out.delivered.length} settlement. The escrow now knows who won.`
      : 'Nothing was waiting to be delivered.'));
  }

  if (el('claim')) {
    el('claim').onclick = (e) => act(e.target, async () => {
      const owed = await baseRead(round.escrow, config.escrow_abi, 'claimable', [currentAccount()]);
      if (owed === 0n) throw new Error('This round owes you nothing.');
      await baseSend(round.escrow, config.escrow_abi, 'claim', []);
    }, 'Claimed. The USDC is in your wallet.');
  }

  if (el('deposit-back')) {
    el('deposit-back').onclick = (e) => act(e.target, async () => {
      if (!mine) throw new Error('You have no application in this round.');
      await baseSend(round.escrow, config.escrow_abi, 'claimDeposit', [Number(mine.application_id) + 1]);
    }, 'Your deposit is back in your wallet.');
  }
}

// ----------------------------------------------------------------- render

async function render() {
  try {
    if (view === 'rounds') await viewRounds();
    else if (view === 'open') viewOpen();
    else if (view === 'round') await viewRound();
    paintWallet();
  } catch (err) {
    el('view').innerHTML = `
      <h1>That did not load</h1>
      <p class="lede">${esc(String(err?.message || err))}</p>
      <div class="row"><button class="act" data-go="${esc(view)}">Try again</button></div>`;
  }
}

shell();
config = await loadConfig();
el('addresses').innerHTML = `registry ${shortAddr(config.registry)} · bridge ${shortAddr(config.bridge)}`;
if (window.ethereum) {
  const accounts = await window.ethereum.request({ method: 'eth_accounts' });
  if (accounts[0]) await connect().catch(() => {});
}
await render();
