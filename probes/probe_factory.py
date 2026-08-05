# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Measures the three runtime capabilities the settlement design rests on.

1. A contract deploying a contract, gl.deploy_contract, and whether the child's
   address can be recovered afterwards. Deployment is asynchronous and only
   happens once the parent transaction finalises, so the address cannot simply
   be returned to the caller.
2. A contract calling another contract, gl.get_contract_at(...).emit(), and what
   the callee sees as sender and origin.
3. A contract moving value to an address it holds, and whether the recipient's
   real chain balance changes rather than only the contract's bookkeeping.

Nothing here judges anything. That is the point: the design puts the consensus
round in a separate judge contract, so the part that moves money is ordinary
deterministic code.
"""

from genlayer import *
import json


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


class ProbeFactory(gl.Contract):
    child_code: str
    deploy_attempts: u256
    known_children: DynArray[str]
    log: DynArray[str]
    owner: str

    def __init__(self) -> None:
        self.owner = gl.message.sender_address.as_hex
        self.child_code = ""
        self.deploy_attempts = u256(0)

    def _log(self, entry: str) -> None:
        self.log.append(str(entry)[:300])

    @gl.public.write
    def set_child_code(self, code: str) -> None:
        """The child's source, uploaded once so the factory can deploy copies."""
        if gl.message.sender_address.as_hex != self.owner:
            raise gl.vm.UserError("owner only")
        self.child_code = str(code)
        self._log("CHILD_CODE_SET len=" + str(len(str(code))))

    # ---------------------------------------------------------- capability 1

    @gl.public.write
    def spawn(self, label: str, salt: str) -> None:
        """Deploy a child. The address arrives later, not as a return value."""
        if len(self.child_code) == 0:
            raise gl.vm.UserError("child code not set")
        self.deploy_attempts = u256(int(self.deploy_attempts) + 1)
        # on="accepted" rather than "finalized". The first probe used
        # finalized and the message was recorded but never executed, while a
        # working project in the wild uses the default, which is accepted.
        addr = gl.deploy_contract(
            code=self.child_code.encode("utf-8"),
            args=[str(label)],
            salt_nonce=u256(int(salt)),
            on="accepted",
        )
        # Recorded as text because what is being measured is whether anything
        # comes back at all, and in what shape.
        self._log("SPAWN label=" + str(label) + " salt=" + str(salt) + " returned=" + str(addr))

    @gl.public.write
    def remember_child(self, address_hex: str) -> None:
        """Register a child address observed off chain, so later calls can use it."""
        self.known_children.append(str(address_hex))
        self._log("CHILD_REMEMBERED " + str(address_hex))

    # ---------------------------------------------------------- capability 2

    @gl.public.write
    def call_child(self, address_hex: str, text: str) -> None:
        """Contract to contract call. The callee records who it thinks called."""
        child = gl.get_contract_at(Address(str(address_hex)))
        child.emit(on="accepted").note(str(text))
        self._log("CALLED " + str(address_hex))

    # ---------------------------------------------------------- capability 3

    @gl.public.write.payable
    def take(self) -> None:
        """Somewhere to put value before trying to move it out again."""
        self._log("TOOK " + str(int(gl.message.value)))

    @gl.public.write
    def pay_out(self, to_hex: str, amount_wei: str) -> None:
        """Move value out and record what the contract believed it sent.

        The claim being tested is not this log line. It is whether the
        recipient's balance, read from the chain afterwards, changed by the
        same amount.
        """
        amount = u256(int(amount_wei))
        if int(amount) > int(self.balance):
            raise gl.vm.UserError("not enough balance")
        _Recipient(Address(str(to_hex))).emit_transfer(value=amount)
        self._log("PAID " + str(to_hex) + " " + str(int(amount)))

    @gl.public.view
    def state(self) -> str:
        return json.dumps({
            "owner": self.owner,
            "child_code_len": len(self.child_code),
            "deploy_attempts": str(int(self.deploy_attempts)),
            "known_children": list(self.known_children),
            "balance_wei": str(int(self.balance)),
            "log": list(self.log),
        })
