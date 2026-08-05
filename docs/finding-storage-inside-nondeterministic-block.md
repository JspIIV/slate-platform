## Summary

Reading contract storage from inside the function passed to `gl.eq_principle.prompt_comparative` makes the transaction end `FINISHED_WITH_ERROR` on chain id 4221. The identical round succeeds when the same value is read into a local before the block opens. Studio does not enforce this, so a contract can work there for months and fail on every attempt once deployed to the public network, with nothing in the error to suggest why.

## Reproduction

One contract, four methods, same prompt and same equivalence rule in each. Only the position of the storage read differs.

```python
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json


class ProbeStorage(gl.Contract):
    subject: str
    lines: DynArray[str]
    results: TreeMap[str, str]

    def __init__(self) -> None:
        self.subject = ("ripgrep, a line oriented search tool that respects "
                        "gitignore, widely used and documented")

    @gl.public.write
    def add_line(self, text: str) -> None:
        self.lines.append(str(text))

    def _ask(self, subject: str) -> str:
        raw = str(gl.nondet.exec_prompt(
            "Here is a project description: '" + subject + "'. "
            "Does it describe a real developer tool? Answer with ONLY "
            '{"tier": "LEAD"} or {"tier": "DECLINED"}.'
        ))
        text = raw.strip()
        start, end = text.find("{"), text.rfind("}") + 1
        if start >= 0 and end > start:
            text = text[start:end]
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            return json.dumps({"ok": False, "tier": ""})
        return json.dumps({"ok": True, "tier": str(parsed.get("tier", ""))})

    RULE = "ok and tier must match exactly between validators."

    @gl.public.write
    def read_inside(self) -> None:
        def run() -> str:
            return self._ask(str(self.subject))          # storage, inside the block
        self.results["read_inside"] = gl.eq_principle.prompt_comparative(run, principle=self.RULE)

    @gl.public.write
    def read_outside(self) -> None:
        subject = str(self.subject)                       # storage, before the block
        def run() -> str:
            return self._ask(subject)
        self.results["read_outside"] = gl.eq_principle.prompt_comparative(run, principle=self.RULE)

    @gl.public.write
    def read_array_inside(self) -> None:
        def run() -> str:
            joined = ""
            for i in range(len(self.lines)):              # collection, inside the block
                joined += str(self.lines[i]) + " "
            return self._ask(joined[:400] if joined else "nothing")
        self.results["read_array_inside"] = gl.eq_principle.prompt_comparative(run, principle=self.RULE)

    @gl.public.write
    def read_array_outside(self) -> None:
        joined = ""
        for i in range(len(self.lines)):                  # collection, before the block
            joined += str(self.lines[i]) + " "
        subject = joined[:400] if joined else "nothing"
        def run() -> str:
            return self._ask(subject)
        self.results["read_array_outside"] = gl.eq_principle.prompt_comparative(run, principle=self.RULE)

    @gl.public.view
    def state(self) -> str:
        return json.dumps({k: self.results[k] for k in self.results})
```

Deploy, call `add_line("ripgrep is a fast search tool used widely")`, then call the four judging methods.

## Result

Deployed at `0x0838f1644E354dDa27D5e96e6727Ab9Eba9589c1`.

| Method | Where the storage is read | Outcome |
|---|---|---|
| `read_outside` | into a local, before the block | `FINISHED_WITH_RETURN`, `{"ok": true, "tier": "LEAD"}` |
| `read_array_outside` | into a local, before the block | `FINISHED_WITH_RETURN`, `{"ok": true, "tier": "LEAD"}` |
| `read_inside` | `self.subject`, inside the block | `FINISHED_WITH_ERROR` |
| `read_array_inside` | `self.lines[i]`, inside the block | `FINISHED_WITH_ERROR` |

`read_outside` returned `NOT_VOTED` on its first attempt and succeeded on the next with no change, so the two failures are not flakiness: the outside variants pass, the inside variants never do.

Isolated separately on the same network and all fine inside a block: `gl.nondet.web.render` (17835 characters retrieved), `gl.nondet.exec_prompt`, and both together in one block. So it is specifically the storage access.

## Why it is worth a warning even if it is intended

A contract written this way works in Studio. Deployed, every judging transaction fails, and the error says only `FINISHED_WITH_ERROR`, which reads like a consensus failure rather than an illegal access. It cost me weeks: I concluded the validator set could not agree on a large bound structure and redesigned around a limitation that did not exist. The contract judged correctly on the first attempt once the reads were moved out.

If the restriction is deliberate, the [equivalence principles](https://docs.genlayer.com/developers/intelligent-contracts/features/equivalence-principle) page saying so plainly would be enough, together with a sentence in the error. If it is not deliberate, the probe above should make it easy to see.
