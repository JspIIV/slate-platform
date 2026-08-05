# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Splits a failing consensus round into its parts, one method per suspect.

Judging fails on chain id 4221 even over two applications and even with a
compact binding, so the cause is not the size of what validators must agree on.
Three things happen inside that round: a page is fetched, a model is prompted,
and the two are combined. Each is isolated here.

A note on the earlier mistake this corrects: web access is only permitted inside
a nondeterministic block, so a view that fetches returns `6: forbidden` and
measures nothing. Every fetch below sits inside the block, where it belongs.
"""

from genlayer import *
import json


class ProbeLlm(gl.Contract):
    results: TreeMap[str, str]

    def __init__(self) -> None:
        pass

    def _record(self, key: str, value: str) -> None:
        self.results[str(key)] = str(value)[:600]

    @gl.public.write
    def only_fetch(self, url: str) -> None:
        """Retrieval alone, no model."""
        def run() -> str:
            try:
                page = str(gl.nondet.web.render(str(url), mode="text"))
                return json.dumps({"ok": True, "chars": len(page), "head": page[:120].replace("\n", " ")})
            except Exception as exc:
                return json.dumps({"ok": False, "chars": 0, "head": str(exc)[:200]})

        out = gl.eq_principle.prompt_comparative(
            run, principle="ok and chars must match exactly. head may differ in wording.")
        self._record("only_fetch", out)

    @gl.public.write
    def only_prompt(self) -> None:
        """A model call alone, no retrieval, and a tiny answer to agree on."""
        def run() -> str:
            try:
                raw = str(gl.nondet.exec_prompt(
                    "Answer with ONLY this JSON and nothing else: "
                    '{"tier": "LEAD"}'
                ))
                text = raw.strip()
                start, end = text.find("{"), text.rfind("}") + 1
                if start >= 0 and end > start:
                    text = text[start:end]
                parsed = json.loads(text)
                return json.dumps({"ok": True, "tier": str(parsed.get("tier", ""))})
            except Exception as exc:
                return json.dumps({"ok": False, "tier": "", "why": str(exc)[:200]})

        out = gl.eq_principle.prompt_comparative(
            run, principle="ok and tier must match exactly between validators.")
        self._record("only_prompt", out)

    @gl.public.write
    def prompt_about_text(self) -> None:
        """A model call over text the contract supplies, still no retrieval."""
        def run() -> str:
            try:
                raw = str(gl.nondet.exec_prompt(
                    "Here is a project description: 'ripgrep, a line oriented search "
                    "tool that respects gitignore, widely used and documented'. "
                    "Does it describe a real developer tool? Answer with ONLY "
                    '{"tier": "LEAD"} or {"tier": "DECLINED"}.'
                ))
                text = raw.strip()
                start, end = text.find("{"), text.rfind("}") + 1
                if start >= 0 and end > start:
                    text = text[start:end]
                parsed = json.loads(text)
                return json.dumps({"ok": True, "tier": str(parsed.get("tier", ""))})
            except Exception as exc:
                return json.dumps({"ok": False, "tier": "", "why": str(exc)[:200]})

        out = gl.eq_principle.prompt_comparative(
            run, principle="ok and tier must match exactly between validators.")
        self._record("prompt_about_text", out)

    @gl.public.write
    def fetch_then_prompt(self, url: str) -> None:
        """Both, in one block, which is what a real round does."""
        def run() -> str:
            try:
                page = str(gl.nondet.web.render(str(url), mode="text"))[:4000]
            except Exception as exc:
                return json.dumps({"ok": False, "tier": "", "why": "fetch: " + str(exc)[:180]})
            try:
                raw = str(gl.nondet.exec_prompt(
                    "Below is a page. Does it show a real, maintained developer tool? "
                    'Answer with ONLY {"tier": "LEAD"} or {"tier": "DECLINED"}.\n\n'
                    + page
                ))
                text = raw.strip()
                start, end = text.find("{"), text.rfind("}") + 1
                if start >= 0 and end > start:
                    text = text[start:end]
                parsed = json.loads(text)
                return json.dumps({"ok": True, "tier": str(parsed.get("tier", ""))})
            except Exception as exc:
                return json.dumps({"ok": False, "tier": "", "why": "prompt: " + str(exc)[:180]})

        out = gl.eq_principle.prompt_comparative(
            run, principle="ok and tier must match exactly between validators.")
        self._record("fetch_then_prompt", out)

    @gl.public.view
    def state(self) -> str:
        return json.dumps({k: self.results[k] for k in self.results})
