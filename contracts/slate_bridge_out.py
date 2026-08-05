# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""The outbound side of the settlement path: verdicts leaving GenLayer.

A round hands its verdict here, and a relayer reads it and submits it to the
escrow on the settlement chain. Deliberately dumb: it stores and it hands back,
it never decides anything.

The relayer is the uncomfortable part of the design, so its power is bounded on
both ends rather than trusted. Here, only a round the registry knows about can
post a settlement, and each one gets an id that is recorded as delivered so the
same verdict cannot be posted twice. On the settlement chain, the escrow checks
that the message names the round it was linked to at deployment, and refuses
awards that exceed the pot it holds. And if the relayer simply never runs, the
escrow's grace period gives the sponsor and every applicant their money back.
"""

from genlayer import *
from datetime import datetime, timezone
import json


ERROR_EXPECTED = "[EXPECTED_ERROR]"


def _addr(address) -> str:
    return str(address).lower()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class SlateBridgeOut(gl.Contract):
    admin: str
    registry: str
    messages: DynArray[str]
    delivered: TreeMap[str, bool]

    def __init__(self) -> None:
        self.admin = _addr(gl.message.sender_address.as_hex)
        self.registry = ""

    @gl.public.write
    def set_registry(self, registry: str) -> None:
        """Bound once, so the set of contracts that may post cannot be widened later."""
        if _addr(gl.message.sender_address.as_hex) != self.admin:
            raise gl.vm.UserError(ERROR_EXPECTED + " Admin only")
        if self.registry != "":
            raise gl.vm.UserError(ERROR_EXPECTED + " The registry is already set")
        self.registry = _addr(registry)

    @gl.public.write
    def send_settlement(self, target_chain_id: str, escrow_address: str, payload: str) -> None:
        """Called by a round contract, never by a person.

        The caller is `gl.message.sender_address`, which on a contract to
        contract call is the calling contract. The registry is asked whether it
        knows that address, so a stray contract cannot post a verdict for an
        escrow it has nothing to do with.
        """
        sender = _addr(gl.message.sender_address.as_hex)

        if self.registry != "":
            registry = gl.get_contract_at(Address(str(self.registry)))
            known = registry.view().is_round(sender)
            if not known:
                raise gl.vm.UserError(ERROR_EXPECTED + " The caller is not a registered round")

        message_id = str(len(self.messages))
        self.messages.append(json.dumps({
            "message_id": message_id,
            "round": sender,
            "chain_id": str(target_chain_id),
            "escrow": _addr(escrow_address),
            "payload": str(payload),
            "created_at": _now_iso(),
        }))

    @gl.public.write
    def mark_delivered(self, message_id: str, tx_hash: str) -> None:
        """The relayer records where it landed, so the trail is public.

        This is bookkeeping, not permission: the escrow decides for itself
        whether to accept a settlement, and it refuses a second one regardless
        of what is written here.
        """
        index = int(message_id)
        if index < 0 or index >= len(self.messages):
            raise gl.vm.UserError(ERROR_EXPECTED + " No such message")
        message = json.loads(self.messages[index])
        message["delivered_tx"] = str(tx_hash)[:80]
        message["delivered_at"] = _now_iso()
        message["delivered_by"] = _addr(gl.message.sender_address.as_hex)
        self.messages[index] = json.dumps(message)
        self.delivered[str(message_id)] = True

    @gl.public.view
    def get_message(self, message_id: str) -> str:
        index = int(message_id)
        if index < 0 or index >= len(self.messages):
            return json.dumps({"error": "no such message"})
        return self.messages[index]

    @gl.public.view
    def get_pending(self) -> str:
        """Everything a relayer still has to deliver."""
        out = []
        for i in range(len(self.messages)):
            if not self.delivered.get(str(i), False):
                out.append(json.loads(self.messages[i]))
        return json.dumps(out)

    @gl.public.view
    def get_messages(self) -> str:
        return json.dumps([json.loads(m) for m in self.messages])

    @gl.public.view
    def get_stats(self) -> str:
        pending = 0
        for i in range(len(self.messages)):
            if not self.delivered.get(str(i), False):
                pending += 1
        return json.dumps({
            "admin": self.admin,
            "registry": self.registry,
            "messages": len(self.messages),
            "pending": pending,
        })
