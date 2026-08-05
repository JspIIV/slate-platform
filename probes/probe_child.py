# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""The child a factory deploys, and the callee of a contract to contract call.

Deliberately tiny. Everything it records answers one question: did the call
actually arrive, and who did the runtime say made it. Both matter, because a
settlement contract that cannot prove its caller cannot be trusted to pay out.
"""

from genlayer import *
import json


class ProbeChild(gl.Contract):
    label: str
    creator: str
    calls: u256
    last_caller: str
    last_origin: str
    last_note: str
    received_wei: u256

    def __init__(self, label: str) -> None:
        self.label = str(label)
        # Who the runtime reports as the sender when a contract deploys a
        # contract. If a factory is going to own its children, this has to be
        # the factory address rather than the human who called the factory.
        self.creator = gl.message.sender_address.as_hex
        self.calls = u256(0)
        self.last_caller = ""
        self.last_origin = ""
        self.last_note = ""
        self.received_wei = u256(0)

    @gl.public.write
    def note(self, text: str) -> None:
        self.calls = u256(int(self.calls) + 1)
        self.last_caller = gl.message.sender_address.as_hex
        self.last_origin = gl.message.origin_address.as_hex
        self.last_note = str(text)[:200]

    @gl.public.write.payable
    def fund(self) -> None:
        self.received_wei = u256(int(self.received_wei) + int(gl.message.value))
        self.last_caller = gl.message.sender_address.as_hex

    @gl.public.view
    def state(self) -> str:
        return json.dumps({
            "label": self.label,
            "creator": self.creator,
            "calls": str(int(self.calls)),
            "last_caller": self.last_caller,
            "last_origin": self.last_origin,
            "last_note": self.last_note,
            "received_wei": str(int(self.received_wei)),
            "balance_wei": str(int(self.balance)),
        })
