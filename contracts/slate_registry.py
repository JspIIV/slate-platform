# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""The catalogue of rounds. It holds no value and judges nothing.

Its whole job is to be the one place that says which round contracts are real,
so a frontend can list them and the bridge can refuse a settlement from a
contract nobody registered.

Why a backend registers rounds rather than the registry deploying them: on this
network `gl.deploy_contract` returns an address where no contract ever appears,
measured and reported as genvm-manager#20. So a deployer key opens each round
and records it here, and the trust that places in the backend is bounded by
what a round can actually do afterwards. It cannot mint money, cannot pay
anybody, and cannot settle: the escrow on the settlement chain only accepts a
verdict from the round address it was linked to at deployment, and it refuses
awards larger than the pot it holds.
"""

from genlayer import *
from datetime import datetime, timezone
import json


ERROR_EXPECTED = "[EXPECTED_ERROR]"

STATUS_OPEN = "OPEN"
STATUS_JUDGED = "JUDGED"
STATUS_ABANDONED = "ABANDONED"


def _addr(address) -> str:
    return str(address).lower()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_epoch() -> int:
    return int(datetime.now(timezone.utc).timestamp())


class SlateRegistry(gl.Contract):
    admin: str
    deployer: str
    rounds: DynArray[str]                 # JSON, index is the round id
    round_index: TreeMap[str, str]        # round address -> round id
    audit: DynArray[str]

    def __init__(self, deployer: str) -> None:
        self.admin = _addr(gl.message.sender_address.as_hex)
        self.deployer = _addr(deployer)
        self._audit("REGISTRY_OPENED", self.admin, "deployer " + self.deployer)

    def _audit(self, action: str, actor: str, detail: str) -> None:
        self.audit.append(json.dumps({
            "action": str(action),
            "actor": _addr(actor),
            "detail": str(detail)[:200],
            "at": _now_iso(),
        }))

    @gl.public.write
    def set_deployer(self, deployer: str) -> None:
        if _addr(gl.message.sender_address.as_hex) != self.admin:
            raise gl.vm.UserError(ERROR_EXPECTED + " Admin only")
        self.deployer = _addr(deployer)
        self._audit("DEPLOYER_CHANGED", self.admin, self.deployer)

    # ------------------------------------------------------------ recording

    @gl.public.write
    def record_round(
        self,
        round_contract: str,
        escrow_address: str,
        settlement_chain_id: str,
        sponsor: str,
        title: str,
        purpose: str,
        pot_units: str,
        deposit_units: str,
        closes_at_epoch: str,
    ) -> None:
        """Adds a round to the catalogue. Only the deployer may call it."""
        if _addr(gl.message.sender_address.as_hex) != self.deployer:
            raise gl.vm.UserError(ERROR_EXPECTED + " Only the registered deployer may record a round")

        address = _addr(round_contract)
        if self.round_index.get(address, "") != "":
            raise gl.vm.UserError(ERROR_EXPECTED + " That round is already recorded")

        round_id = str(len(self.rounds))
        self.rounds.append(json.dumps({
            "round_id": round_id,
            "round_contract": address,
            "escrow_address": _addr(escrow_address),
            "settlement_chain_id": str(settlement_chain_id),
            "sponsor": _addr(sponsor),
            "title": str(title)[:160],
            "purpose": str(purpose)[:600],
            "pot_units": str(pot_units),
            "deposit_units": str(deposit_units),
            "closes_at_epoch": str(closes_at_epoch),
            "status": STATUS_OPEN,
            "funded_count": 0,
            "allocated_units": "0",
            "recorded_at": _now_iso(),
        }))
        self.round_index[address] = round_id
        self._audit("ROUND_RECORDED", address, str(title)[:120])

    @gl.public.write
    def record_result(self, funded_count: str, allocated_units: str, status: str) -> None:
        """Called by a round contract about itself, and about nothing else.

        The caller is `gl.message.sender_address`, which on a contract to
        contract call is the calling contract, so a round can only ever write
        its own row. That is the whole access rule and it needs no list of
        permissions to maintain.
        """
        caller = _addr(gl.message.sender_address.as_hex)
        round_id = self.round_index.get(caller, "")
        if round_id == "":
            raise gl.vm.UserError(ERROR_EXPECTED + " The caller is not a recorded round")

        row = json.loads(self.rounds[int(round_id)])
        new_status = str(status).strip().upper()
        if new_status not in (STATUS_JUDGED, STATUS_ABANDONED):
            raise gl.vm.UserError(ERROR_EXPECTED + " A round settles as JUDGED or ABANDONED")

        row["status"] = new_status
        row["funded_count"] = int(funded_count)
        row["allocated_units"] = str(allocated_units)
        row["settled_at"] = _now_iso()
        self.rounds[int(round_id)] = json.dumps(row)
        self._audit("RESULT_RECORDED", caller, new_status + " " + str(funded_count) + " funded")

    # ---------------------------------------------------------------- views

    @gl.public.view
    def is_round(self, address: str) -> bool:
        """The bridge asks this before accepting a settlement."""
        return self.round_index.get(_addr(address), "") != ""

    @gl.public.view
    def get_round(self, round_id: str) -> str:
        index = int(round_id)
        if index < 0 or index >= len(self.rounds):
            return json.dumps({"error": "no such round"})
        return self.rounds[index]

    @gl.public.view
    def get_round_by_address(self, address: str) -> str:
        round_id = self.round_index.get(_addr(address), "")
        if round_id == "":
            return json.dumps({"error": "not a recorded round"})
        return self.rounds[int(round_id)]

    @gl.public.view
    def get_rounds_by_status(self, status: str) -> str:
        wanted = str(status).strip().upper()
        out = []
        for raw in self.rounds:
            row = json.loads(raw)
            if row["status"] == wanted:
                out.append(row)
        return json.dumps(out)

    @gl.public.view
    def get_open_rounds(self) -> str:
        """Open and still inside their window, which is what an applicant wants."""
        now = _now_epoch()
        out = []
        for raw in self.rounds:
            row = json.loads(raw)
            if row["status"] == STATUS_OPEN and int(row["closes_at_epoch"]) > now:
                out.append(row)
        return json.dumps(out)

    @gl.public.view
    def get_recent_rounds(self, limit: str) -> str:
        count = max(1, min(50, int(limit)))
        out = []
        i = len(self.rounds) - 1
        while i >= 0 and len(out) < count:
            out.append(json.loads(self.rounds[i]))
            i -= 1
        return json.dumps(out)

    @gl.public.view
    def get_sponsor_rounds(self, address: str) -> str:
        who = _addr(address)
        return json.dumps([json.loads(r) for r in self.rounds if json.loads(r)["sponsor"] == who])

    @gl.public.view
    def get_audit_trail(self) -> str:
        return json.dumps([json.loads(a) for a in self.audit])

    @gl.public.view
    def get_stats(self) -> str:
        open_count = 0
        judged = 0
        allocated = 0
        for raw in self.rounds:
            row = json.loads(raw)
            if row["status"] == STATUS_OPEN:
                open_count += 1
            elif row["status"] == STATUS_JUDGED:
                judged += 1
            allocated += int(row["allocated_units"])
        return json.dumps({
            "rounds": len(self.rounds),
            "open": open_count,
            "judged": judged,
            "allocated_units": str(allocated),
            "admin": self.admin,
            "deployer": self.deployer,
        })

    @gl.public.view
    def get_frontend_bootstrap(self) -> str:
        return json.dumps({
            "admin": self.admin,
            "deployer": self.deployer,
            "rounds": [json.loads(r) for r in self.rounds],
            "tier_shares": {"LEAD": 4, "STRONG": 2, "PARTIAL": 1, "DECLINED": 0},
        })
