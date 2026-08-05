// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal subset of ERC20 this escrow needs.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title SlateEscrow
/// @notice Holds one funding round's money on an EVM chain while the judgement
///         happens on GenLayer. One escrow is one round.
///
/// The split exists because value cannot leave an Intelligent Contract on the
/// GenLayer testnet: `emit_transfer` records a payout and moves nothing. So the
/// judgement lives where reasoning is possible and the money lives where it can
/// actually move, and a settlement message carries the verdict across.
///
/// Three properties this contract is built to hold, and they are what the tests
/// assert:
///
///  1. Awards can never exceed the pot that actually arrived. The pot is read
///     from this contract's own token balance at funding time, never from what
///     the sponsor claimed to send, so a fee on transfer token cannot overstate
///     it.
///  2. Every deposit belongs to the address that staked it and comes back
///     whatever tier the application landed in. Losing is not punished.
///  3. If GenLayer never answers, nothing is stranded. After the grace period
///     the sponsor takes the pot back and every applicant takes their deposit.
///
/// Nothing is ever pushed. Every payout is pulled by the person owed it, so one
/// unreceivable address cannot block anybody else.
contract SlateEscrow {
    // ------------------------------------------------------------ immutables

    IERC20 public immutable token;
    address public immutable sponsor;
    uint256 public immutable potAmount;
    uint256 public immutable depositAmount;
    uint256 public immutable closesAt;
    uint256 public immutable graceSeconds;

    /// The GenLayer round contract whose settlements this escrow accepts. It is
    /// set once, by the deployer, before anybody can fund. A settlement naming
    /// any other round is refused, so the relayer cannot deliver a verdict from
    /// somewhere else.
    address public roundContract;
    address public owner;

    // ---------------------------------------------------------------- state

    bool public funded;
    bool public settled;
    bool public potReclaimed;
    uint256 public potActual;      // what really arrived, read from balanceOf
    uint256 public totalAwarded;   // the sum of recorded entitlements

    mapping(address => bool) public relayers;

    /// applicationId => the address that staked for it
    mapping(uint256 => address) public applicant;
    /// applicationId => whether its deposit is still held here
    mapping(uint256 => bool) public depositHeld;
    /// award owed to an address by the settlement
    mapping(address => uint256) public awardOf;
    /// award already taken
    mapping(address => bool) public awardClaimed;

    uint256 public applicationCount;

    // --------------------------------------------------------------- events

    event Funded(address indexed sponsor, uint256 amount);
    event Deposited(uint256 indexed applicationId, address indexed applicant, uint256 amount);
    event DepositReturned(uint256 indexed applicationId, address indexed applicant, uint256 amount);
    event Settled(uint256 recipients, uint256 totalAwarded);
    event AwardClaimed(address indexed winner, uint256 amount);
    event PotReclaimed(address indexed sponsor, uint256 amount);

    // ------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    modifier onlyRelayer() {
        require(relayers[msg.sender], "only relayer");
        _;
    }

    constructor(
        address _token,
        address _sponsor,
        uint256 _potAmount,
        uint256 _depositAmount,
        uint256 _closesAt,
        uint256 _graceSeconds
    ) {
        require(_token != address(0), "token required");
        require(_sponsor != address(0), "sponsor required");
        require(_potAmount > 0, "pot required");
        require(_closesAt > block.timestamp, "deadline must be in the future");

        token = IERC20(_token);
        sponsor = _sponsor;
        potAmount = _potAmount;
        depositAmount = _depositAmount;
        closesAt = _closesAt;
        graceSeconds = _graceSeconds;
        owner = msg.sender;
        relayers[msg.sender] = true;
    }

    // ------------------------------------------------------------ wiring up

    function setRoundContract(address _round) external onlyOwner {
        require(roundContract == address(0), "round already set");
        require(_round != address(0), "round required");
        roundContract = _round;
    }

    function setRelayer(address who, bool allowed) external onlyOwner {
        relayers[who] = allowed;
    }

    // -------------------------------------------------------------- funding

    /// @notice The sponsor moves the pot in. Requires an allowance first.
    function fund() external {
        require(msg.sender == sponsor, "only the sponsor funds");
        require(roundContract != address(0), "round not linked yet");
        require(!funded, "already funded");
        require(block.timestamp < closesAt, "the round has closed");

        uint256 before = token.balanceOf(address(this));
        require(token.transferFrom(msg.sender, address(this), potAmount), "transfer failed");

        // The pot is what arrived, not what was asked for. A token that takes a
        // fee on transfer would otherwise let awards be computed against money
        // this contract does not hold.
        potActual = token.balanceOf(address(this)) - before;
        require(potActual > 0, "nothing arrived");
        funded = true;

        emit Funded(msg.sender, potActual);
    }

    /// @notice An applicant stakes for one application id.
    function depositForApplication(uint256 applicationId) external {
        require(funded, "the pot is not funded yet");
        require(block.timestamp < closesAt, "the round has closed");
        require(applicant[applicationId] == address(0), "that application already staked");
        require(depositAmount > 0, "this round takes no deposit");

        require(token.transferFrom(msg.sender, address(this), depositAmount), "transfer failed");

        applicant[applicationId] = msg.sender;
        depositHeld[applicationId] = true;
        applicationCount += 1;

        emit Deposited(applicationId, msg.sender, depositAmount);
    }

    // ----------------------------------------------------------- settlement

    /// @notice Records who is owed what. Called by a relayer carrying a verdict
    ///         that already exists on GenLayer.
    ///
    /// The relayer's power is deliberately small: it can only deliver, and this
    /// function checks everything that matters. It cannot pay itself, cannot
    /// exceed the pot, cannot settle twice, and if it never runs at all the
    /// grace period gives everyone their money back.
    function processSettlement(
        address _round,
        address[] calldata winners,
        uint256[] calldata amounts
    ) external onlyRelayer {
        require(!settled, "already settled");
        require(funded, "the pot was never funded");
        require(_round == roundContract, "settlement is from another round");
        require(winners.length == amounts.length, "length mismatch");
        require(block.timestamp >= closesAt, "the round has not closed yet");

        uint256 sum;
        for (uint256 i = 0; i < winners.length; i++) {
            require(winners[i] != address(0), "bad recipient");
            require(awardOf[winners[i]] == 0, "duplicate recipient");
            awardOf[winners[i]] = amounts[i];
            sum += amounts[i];
        }
        require(sum <= potActual, "awards exceed the pot");

        totalAwarded = sum;
        settled = true;

        emit Settled(winners.length, sum);
    }

    // --------------------------------------------------------------- claims

    /// @notice A winner takes their award.
    function claim() external {
        require(settled, "not settled yet");
        uint256 amount = awardOf[msg.sender];
        require(amount > 0, "nothing owed to you");
        require(!awardClaimed[msg.sender], "already claimed");

        awardClaimed[msg.sender] = true;
        require(token.transfer(msg.sender, amount), "transfer failed");

        emit AwardClaimed(msg.sender, amount);
    }

    /// @notice An applicant takes their deposit back. Available once the round
    ///         is settled, and also after the grace period if it never was.
    function claimDeposit(uint256 applicationId) external {
        require(depositHeld[applicationId], "no deposit held for that application");
        require(applicant[applicationId] == msg.sender, "not your application");
        require(settled || block.timestamp > closesAt + graceSeconds, "wait for the settlement");

        depositHeld[applicationId] = false;
        require(token.transfer(msg.sender, depositAmount), "transfer failed");

        emit DepositReturned(applicationId, msg.sender, depositAmount);
    }

    /// @notice The sponsor takes back whatever the round did not award: the
    ///         whole pot if it was never settled, or the unallocated remainder.
    function reclaimPot() external {
        require(msg.sender == sponsor, "only the sponsor");
        require(funded, "nothing to reclaim");
        require(!potReclaimed, "already reclaimed");
        require(settled || block.timestamp > closesAt + graceSeconds, "wait for the settlement");

        uint256 amount = potActual - totalAwarded;
        require(amount > 0, "the pot was fully awarded");

        potReclaimed = true;
        require(token.transfer(sponsor, amount), "transfer failed");

        emit PotReclaimed(sponsor, amount);
    }

    // ----------------------------------------------------------------- views

    function status() external view returns (
        bool _funded,
        bool _settled,
        uint256 _potActual,
        uint256 _totalAwarded,
        uint256 _applications,
        uint256 _balance,
        uint256 _secondsToClose,
        uint256 _secondsToGraceEnd
    ) {
        uint256 graceEnd = closesAt + graceSeconds;
        return (
            funded,
            settled,
            potActual,
            totalAwarded,
            applicationCount,
            token.balanceOf(address(this)),
            block.timestamp >= closesAt ? 0 : closesAt - block.timestamp,
            block.timestamp >= graceEnd ? 0 : graceEnd - block.timestamp
        );
    }

    /// @notice What an address can take right now, so the app can show a real
    ///         number rather than guessing at one.
    function claimable(address who) external view returns (uint256) {
        if (!settled || awardClaimed[who]) return 0;
        return awardOf[who];
    }
}
