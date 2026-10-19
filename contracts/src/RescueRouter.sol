// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC3009USDC {
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
    ) external;

    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice One-call, non-custodial split of a user-authorized native USDC rescue.
/// @dev The victim signs both Circle's EIP-3009 authorization to this contract
///      and this router's EIP-712 route consent. Funds are split atomically and
///      this contract has no owner, upgrade, arbitrary-call, or sweep function.
contract RescueRouter {
    error InvalidToken();
    error InvalidRoute();
    error InvalidWindow();
    error RouteExpired();
    error RouteAlreadyUsed();
    error InvalidRouteSignature();
    error TransferFailed();
    error ReentrantCall();

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ZecRescue RescueRouter");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant ROUTE_TYPEHASH = keccak256(
        "RescueRoute(address owner,address token,uint256 amount,address depositAddress,address relayer,uint256 reimbursementAmount,uint256 validAfter,uint256 validBefore,bytes32 transferNonce,bytes32 routeNonce)"
    );
    // secp256k1n / 2, rejecting malleable ECDSA signatures.
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 public constant MAX_AUTHORIZATION_TTL = 300;

    struct RescueRoute {
        address owner;
        address token;
        uint256 amount;
        address depositAddress;
        address relayer;
        uint256 reimbursementAmount;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 transferNonce;
        bytes32 routeNonce;
    }

    address public immutable usdc;
    mapping(address owner => mapping(bytes32 nonce => bool used)) public routeNonceUsed;
    uint256 private entered = 1;

    event RescueExecuted(
        address indexed owner,
        address indexed relayer,
        address indexed depositAddress,
        uint256 amount,
        uint256 reimbursementAmount,
        bytes32 routeNonce,
        bytes32 transferNonce
    );

    constructor(address usdcAddress) {
        if (usdcAddress == address(0) || usdcAddress.code.length == 0) revert InvalidToken();
        usdc = usdcAddress;
    }

    function execute(
        RescueRoute calldata route,
        uint8 transferV,
        bytes32 transferR,
        bytes32 transferS,
        uint8 routeV,
        bytes32 routeR,
        bytes32 routeS
    ) external returns (uint256 forwardedAmount) {
        if (entered != 1) revert ReentrantCall();
        entered = 2;
        _validateRoute(route, routeV, routeR, routeS);
        routeNonceUsed[route.owner][route.routeNonce] = true;
        _receiveAuthorized(route, transferV, transferR, transferS);
        forwardedAmount = route.amount - route.reimbursementAmount;
        _distribute(route, forwardedAmount);

        emit RescueExecuted(
            route.owner,
            route.relayer,
            route.depositAddress,
            route.amount,
            route.reimbursementAmount,
            route.routeNonce,
            route.transferNonce
        );
        entered = 1;
    }

    function _validateRoute(RescueRoute calldata route, uint8 routeV, bytes32 routeR, bytes32 routeS) private view {
        if (route.token != usdc) revert InvalidToken();
        if (
            route.owner == address(0) ||
            route.relayer == address(0) ||
            route.depositAddress == address(0) ||
            route.owner == route.relayer ||
            route.owner == route.depositAddress ||
            route.relayer == route.depositAddress ||
            route.depositAddress == address(this) ||
            route.amount == 0 ||
            route.reimbursementAmount == 0 ||
            route.reimbursementAmount >= route.amount
        ) revert InvalidRoute();
        if (
            route.validBefore <= route.validAfter ||
            route.validBefore - route.validAfter > MAX_AUTHORIZATION_TTL ||
            route.validBefore > block.timestamp + MAX_AUTHORIZATION_TTL
        ) {
            revert InvalidWindow();
        }
        if (block.timestamp <= route.validAfter || block.timestamp > route.validBefore) revert RouteExpired();
        if (routeNonceUsed[route.owner][route.routeNonce]) revert RouteAlreadyUsed();
        if (msg.sender != route.relayer) revert InvalidRoute();
        if (routeS == bytes32(0) || uint256(routeS) > SECP256K1_HALF_ORDER || (routeV != 27 && routeV != 28)) {
            revert InvalidRouteSignature();
        }
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), _routeStructHash(route)));
        if (ecrecover(digest, routeV, routeR, routeS) != route.owner) revert InvalidRouteSignature();
    }

    function _routeStructHash(RescueRoute calldata route) private pure returns (bytes32) {
        return keccak256(abi.encode(
            ROUTE_TYPEHASH,
            route.owner,
            route.token,
            route.amount,
            route.depositAddress,
            route.relayer,
            route.reimbursementAmount,
            route.validAfter,
            route.validBefore,
            route.transferNonce,
            route.routeNonce
        ));
    }

    function _receiveAuthorized(
        RescueRoute calldata route,
        uint8 transferV,
        bytes32 transferR,
        bytes32 transferS
    ) private {
        IERC3009USDC(usdc).receiveWithAuthorization(
            route.owner, address(this), route.amount, route.validAfter, route.validBefore,
            route.transferNonce, transferV, transferR, transferS
        );
    }

    function _distribute(RescueRoute calldata route, uint256 forwardedAmount) private {
        if (!IERC3009USDC(usdc).transfer(route.relayer, route.reimbursementAmount)) revert TransferFailed();
        if (!IERC3009USDC(usdc).transfer(route.depositAddress, forwardedAmount)) revert TransferFailed();
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            NAME_HASH,
            VERSION_HASH,
            block.chainid,
            address(this)
        ));
    }
}
