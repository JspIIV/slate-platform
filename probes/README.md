# Probes

Small contracts written to answer one question each about what the public
testnet actually does, before any of the platform was designed around a guess.
Both findings they produced are reported upstream: `genvm-manager#20` and
`genvm-manager#22`.

| Probe | Question | Answer |
|---|---|---|
| `probe_factory.py`, `probe_child.py` | Can a contract deploy a contract, call one, and pay one? | Calls arrive in about 105 seconds. Deployment returns an address where nothing appears, and a transfer moves no value. |
| `probe_judge.py` | Does a comparative round stop agreeing as it grows? | It failed at every size, which turned out to be the wrong question. |
| `probe_llm.py` | Is it the fetching, the prompting, or both together? | All three work in isolation, so the round itself was the problem. |
| `probe_storage.py` | Is it reading storage from inside the nondeterministic block? | Yes. Outside the block it judges; inside it errors, every time. |

The order matters more than the code. The third probe only exists because the
second answered "everything fails", which meant the hypothesis behind it was
wrong rather than confirmed, and the fourth only exists because the third
narrowed the difference to a single line.
