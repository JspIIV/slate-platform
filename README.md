# Slate

A funding round where the judgement happens on GenLayer and the money is real
USDC on Base Sepolia.

A sponsor puts up a pot and writes what they want to fund in plain words. Anyone
applies by staking a deposit and citing a page that shows what they built. When
the deadline passes, one round of GenLayer validators reads every application
together and places each in a tier. The contract turns tiers into amounts, the
verdict crosses to the chain holding the money, and the winners claim it
themselves.

* **Registry:** `0xD3C7d3E242b0F5F307507d42952a1d756D0103b3` on GenLayer, chain id 4221
* **Bridge:** `0x35Ab7f518a2698ce400be9b08D87B72dD3768B21`
* **Escrow contract:** [`contracts/SlateEscrow.sol`](contracts/SlateEscrow.sol), one deployed per round on Base Sepolia
* **A completed round:** [escrow on Basescan](https://sepolia.basescan.org/address/0xDeCE2Eb164D11BdCe15e77Fd9973fbB517050940), round `0xD1bd26EA3CB8EE4769d1379Da077DDB797C8FC51`

## Why it is split across two chains

Not for the sake of being cross chain. Every structural choice here follows a
measurement on the public testnet, and those measurements are in
[genvm-manager#20](https://github.com/genlayerlabs/genvm-manager/issues/20).

| Measured on chain id 4221 | What follows |
|---|---|
| `emit_transfer` records a payout and moves no value | No Intelligent Contract in this system holds money at all |
| `gl.deploy_contract` returns an address where no contract appears | The registry cannot spawn rounds, so a deployer key opens each one |
| `gl.get_contract_at(a).emit().method()` arrives, about 105 seconds later | This is the one cross contract link the design leans on, and it carries exactly one thing: the verdict |
| Value can be paid into a contract but never out | Anything an Intelligent Contract holds is stranded, so it holds nothing |

The rule that falls out: **GenLayer decides, Base pays.** Judging lives where
reading a page and weighing it is possible; the money lives where it can
actually move.

## The pieces

```
Base Sepolia                        GenLayer
------------                        --------
SlateEscrow.sol   <-- settlement -- SlateBridgeOut
  holds the pot                       records outgoing verdicts
  holds deposits                    SlateRound          one per round
  pays winners                        judges, and does the arithmetic
                                    SlateRegistry
                                      the catalogue
```

Plus a small backend with two write endpoints, and a web app.

## What is bound by consensus

Validators are **not** asked to agree on a ranking. Independent models will not
reproduce a strict order over a set of applications, and a consensus rule that
cannot hold is worse than none: it either fails constantly or gets quietly
loosened until it means nothing.

They are asked to agree on a **partition**. Every applicant lands in exactly one
of four tiers, and the equivalence rule requires the complete assignment to
match: the same id in the same tier for every validator, none missing, none
twice. Only the wording of each reason may differ.

| Tier | Shares |
|---|---|
| `LEAD` | 4 |
| `STRONG` | 2 |
| `PARTIAL` | 1 |
| `DECLINED` | 0 |

**The model never sees an amount.** It returns tiers. The contract computes
`pot * shares / total`, floored, and the wei the floors leave behind goes to a
single recipient, computed once so it can be handed over only once. That is why
the assignment is bound so tightly: two validators differing on one applicant
are not phrasing a finding differently, they are proposing to pay a different
set of people different amounts out of the same pot.

**`ok` is bound too.** A round that could not be judged pays nobody, so whether
the judgement succeeded decides the destination of every unit in the round.

## How judging was made to work on the testnet

It did not work for months, and the reason turned out to be ours rather than the
network's.

**Nothing inside a nondeterministic block may read contract storage.** A round
that touches `self.<field>` from inside the function passed to
`gl.eq_principle.prompt_comparative` ends `FINISHED_WITH_ERROR` on chain id
4221, every time. The identical round succeeds when the value is read into a
plain local before the block opens. Studio does not enforce this, which is why
it went unnoticed. Isolated with a probe contract: `read_array_outside`
returned a verdict, `read_inside` and `read_array_inside` both errored, same
prompt, same rule, same contract.

So `judge_round` gathers the criteria and every application into locals first,
and the block sees only those.

**Nothing inside that block may raise either.** The deterministic frame around
it cannot catch the exception, so a fallback written to handle a malformed
answer would never run. The parser returns a refusal as data, and a round that
cannot be judged settles as a round with no award: nobody funded, every deposit
returned, the pot back to the sponsor, and `ROUND_NOT_JUDGED` in the audit
trail rather than silence.

**`NOT_VOTED` is not an error.** It means the validators did not complete a
vote; nothing changed, and asking again is correct. Judging returned it once and
succeeded on the next attempt with no code change. A relayer that treats it like
a failure would fall back when it should simply wait.

## The escrow holds three properties

They are what the tests assert, not what the contract says about itself.

1. **Awards can never exceed the pot that actually arrived.** The pot is read
   from the contract's own token balance at funding time, never from what the
   sponsor claimed to send.
2. **Every deposit belongs to whoever staked it** and comes back whatever tier
   the application landed in. Losing is not punished: a forfeited deposit would
   deter exactly the applicants a sponsor wants.
3. **If GenLayer never answers, nothing is stranded.** After the grace period
   the sponsor reclaims the pot and every applicant reclaims their deposit.

Nothing is ever pushed. Every payout is pulled by the person owed it, so one
unreceivable address cannot block anybody else.

```
19 passed, 0 failed
```

## The relayer, and what it cannot do

One piece runs off chain: something has to carry the verdict from GenLayer to
the escrow. That is the least trustless part of the design, so it is worth being
exact rather than quiet about it.

* It **cannot invent a winner.** The escrow accepts a settlement only from the
  round address it was linked to at deployment. Proved on chain: delivering
  another round's verdict was refused with `settlement is from another round`.
* It **cannot inflate an award.** The escrow refuses a total above the pot it
  holds.
* It **cannot pay itself.** It never touches the token.
* It **cannot stall a round forever.** If it never runs, the grace period
  returns the pot and every deposit.

So the worst a broken or hostile relayer can do is delay a settlement, and the
delay has a floor.

The same is true of the deployer key that opens rounds. It exists because
`gl.deploy_contract` does not work on this network, and the sponsor still funds
the escrow from their own wallet: the money never passes through the server.

## Verified on chain, end to end

One round, three addresses, two chains, real USDC.

| Step | Where |
|---|---|
| The sponsor funded a 6 USDC pot | Base, escrow balance moved |
| Two applicants staked 1 USDC each and applied | A deposit on Base, a record on GenLayer, per application |
| Validators judged them together | `judge_round`, ripgrep `LEAD`, an encyclopedia article `DECLINED` |
| The whole pot was allocated | 6 USDC to the funded applicant |
| The verdict crossed | A contract to contract call to the bridge, then a relayed `processSettlement` |
| A verdict from another round was refused | `settlement is from another round`, on chain |
| The winner claimed her award and her deposit | 7 USDC moved to her |
| The declined applicant took his deposit back | 1 USDC, and nothing else |
| Nothing was stranded | The escrow's balance ended at `0` |

A second round was run the same way after the registry was wired to receive
results, and the catalogue now shows it settled: `status=JUDGED funded=1
allocated=6000000`, written by the round contract itself through a contract to
contract call.

The reasoning is on chain too: *"The cited page is a Wikipedia article about the
category of static site generators, not a demonstration of the applicant's own
working tool."*

## Driven through the app

The lifecycle above was run headless. The same flow was then driven through the
web app itself, and doing so found four things a script never would:

* The sponsor had no way to fund a round. The round page offered applications
  and settlement but not the one step without which nothing else can happen.
* An approval and the call that spends it were sent back to back, and the second
  failed with `missing revert data`, which mentions neither approvals nor
  allowances. The allowance is now read back before anything tries to spend it.
* Reading the escrow did not switch the network first, so a wallet left on
  GenLayer after signing an application made the page unable to tell whether a
  round was funded. Buttons then quietly disappeared, which is worse than an
  error.
* Applying touches both chains, so it can be interrupted in the middle and leave
  a deposit staked with no application behind it. The second attempt used to ask
  for a second deposit; it now recognises the stake already held and carries on.

There is also a runtime quirk worth recording. Waiting for a GenLayer receipt
through a wallet provider reaches the consensus contract with a plain `eth_call`,
which answers with nothing on this network, so an accepted transaction reads as
a failure. The app therefore confirms a write by reading the contract back until
it shows the change, which is what a person wanted to know anyway.

At the time of writing the network is not finalising GenLayer transactions:
applications submitted through the app sit at `PENDING` with `NOT_VOTED`, and
GenLayer's own status note says a stall began at about 02:10 UTC on 5 August.
Nothing is lost while that lasts, which is the point of the grace period: the
deposits and the pot are on Base and come back to whoever put them up if the
verdict never arrives. The scripted runs above were completed before it began.

`DEV_WALLET=1` serves a wallet that signs with the project's own test keys, so
the app can be driven where no browser extension exists. It is not a mock: the
app takes its ordinary path and every transaction is real. It is served only
when that variable is set.

## Running it

```bash
cd slate-platform
npm install
npm run compile

REGISTRY=0x… BRIDGE=0x… KEYSTORE=/path/to/keystore.json KEY_PASS=… npm start
```

Then `http://localhost:3000`. The app is built from `app/` into `public/`:

```bash
cd app && npm install && npm run build
```

The whole lifecycle can also be run headless, which is what produced the table
above:

```bash
REGISTRY=0x… BRIDGE=0x… node scripts/end_to_end.mjs
```

It writes each address to `run/state.json` as it goes, so a failed run resumes
rather than starting over. That matters when one testnet transaction takes two
to three minutes.

## Honest limits

The judgement is only as good as the criteria the sponsor wrote and the pages
the applicants cited. Slate can tell a maintained project from an article about
the category, because both are on the page it fetched. It cannot tell whether
the applicant is the person who built the thing: ownership is asserted, not
proved.

The tiers are coarse on purpose, and coarseness has a cost. Two applications
that differ genuinely but slightly will often land in the same tier and be paid
the same. That is the price of a consensus rule that actually holds.

The application id an applicant stakes against on Base is chosen by the app,
not derived from the GenLayer record, because the record does not exist until
after the deposit is made. Two people applying in the same few seconds could
therefore collide on an id, and the escrow refuses the second one. A production
version would reserve the id on GenLayer first and stake against it.
