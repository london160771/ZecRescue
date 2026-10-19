// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Local-test-only EIP-3009 token. Never deploy this file.
contract MockNativeUSDC {
    error InvalidAuthorization();
    error AuthorizationExpired();
    error AuthorizationUsed();
    error TransferFailed();

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("USD Coin");
    bytes32 private constant VERSION_HASH = keccak256("2");
    bytes32 private constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    uint256 public failOnTransferCall;
    uint256 public transferCalls;
    address public callbackTarget;
    bytes public callbackData;

    function mint(address account, uint256 value) external {
        balanceOf[account] += value;
    }

    function setFailOnTransferCall(uint256 callNumber) external {
        failOnTransferCall = callNumber;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (msg.sender != to) revert InvalidAuthorization();
        if (block.timestamp <= validAfter || block.timestamp > validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationUsed();

        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            NAME_HASH,
            VERSION_HASH,
            block.chainid,
            address(this)
        ));
        bytes32 structHash = keccak256(abi.encode(TRANSFER_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        if (ecrecover(digest, v, r, s) != from || balanceOf[from] < value) revert InvalidAuthorization();

        if (callbackTarget != address(0)) {
            (bool success, bytes memory result) = callbackTarget.call(callbackData);
            if (!success) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        transferCalls += 1;
        if (failOnTransferCall != 0 && transferCalls == failOnTransferCall) return false;
        if (balanceOf[msg.sender] < value) revert TransferFailed();
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}
