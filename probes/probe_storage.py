# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Is reading contract storage inside a nondeterministic block what breaks judging?

A probe that touched no storage inside the block ran a fetch, a prompt, and both
together on chain id 4221 without trouble. Two contracts that fail there both
read storage from inside the block. This isolates that single difference:
identical prompt, identical binding, one method reading the text from storage
inside the block and one reading it into a local before the block opens.

If the first fails and the second succeeds, the rule is: gather everything the
block needs into locals first, and the failures in the earlier contracts were
mine rather than the network's.
"""

from genlayer import *
import json


class ProbeStorage(gl.Contract):
    subject: str
    lines: DynArray[str]
    results: TreeMap[str, str]

    def __init__(self) -> None:
        self.subject = (
            "ripgrep, a line oriented search tool that respects gitignore, "
            "widely used and documented"
        )

    @gl.public.write
    def add_line(self, text: str) -> None:
        self.lines.append(str(text))

    def _record(self, key: str, value: str) -> None:
        self.results[str(key)] = str(value)[:400]

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
        """Storage is read from within the block, the way the failing contracts do."""
        def run() -> str:
            return self._ask(str(self.subject))

        self._record("read_inside", gl.eq_principle.prompt_comparative(run, principle=self.RULE))

    @gl.public.write
    def read_outside(self) -> None:
        """Storage is read into a local first, and the block sees only that local."""
        subject = str(self.subject)

        def run() -> str:
            return self._ask(subject)

        self._record("read_outside", gl.eq_principle.prompt_comparative(run, principle=self.RULE))

    @gl.public.write
    def read_array_inside(self) -> None:
        """A collection read inside the block, which is what a round of applications does."""
        def run() -> str:
            joined = ""
            for i in range(len(self.lines)):
                joined += str(self.lines[i]) + " "
            return self._ask(joined[:400] if joined else "nothing")

        self._record("read_array_inside", gl.eq_principle.prompt_comparative(run, principle=self.RULE))

    @gl.public.write
    def read_array_outside(self) -> None:
        """The same collection, copied into a local list before the block opens."""
        joined = ""
        for i in range(len(self.lines)):
            joined += str(self.lines[i]) + " "
        subject = joined[:400] if joined else "nothing"

        def run() -> str:
            return self._ask(subject)

        self._record("read_array_outside", gl.eq_principle.prompt_comparative(run, principle=self.RULE))

    @gl.public.view
    def state(self) -> str:
        return json.dumps({
            "lines": len(self.lines),
            "results": {k: self.results[k] for k in self.results},
        })
