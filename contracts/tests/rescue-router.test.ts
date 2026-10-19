import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBlock } from "@ethereumjs/block";
import { Common, Hardfork, Mainnet, createCustomCommon } from "@ethereumjs/common";
import { createLegacyTx } from "@ethereumjs/tx";
import {
  bytesToHex,
  createAccount,
  createAddressFromPrivateKey,
  createAddressFromString,
  hexToBytes
} from "@ethereumjs/util";
import { createVM, runTx, type VM } from "@ethereumjs/vm";
import solc from "solc";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 31_337;
const NOW = 1_800_000_000n;
const GAS_PRICE = 2_000_000_000n;
const VICTIM_KEY = `0x${"11".repeat(32)}` as Hex;
const RELAYER_KEY = `0x${"22".repeat(32)}` as Hex;
const ATTACKER_KEY = `0x${"55".repeat(32)}` as Hex;
const DEPOSIT = `0x${"33".repeat(20)}` as Address;
const OTHER = `0x${"44".repeat(20)}` as Address;
const VICTIM = privateKeyToAccount(VICTIM_KEY);
const RELAYER = privateKeyToAccount(RELAYER_KEY);
const ATTACKER = privateKeyToAccount(ATTACKER_KEY);
const VICTIM_ADDRESS = createAddressFromString(VICTIM.address);
const RELAYER_ADDRESS = createAddressFromString(RELAYER.address);
const ATTACKER_ADDRESS = createAddressFromString(ATTACKER.address);
const transferTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
} as const;
const routeTypes = {
  RescueRoute: [
    { name: "owner", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "depositAddress", type: "address" },
    { name: "relayer", type: "address" },
    { name: "reimbursementAmount", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "transferNonce", type: "bytes32" },
    { name: "routeNonce", type: "bytes32" }
  ]
} as const;

type CompiledContract = { abi: Abi; bytecode: Hex };
type SignatureParts = { v: number; r: Hex; s: Hex };
type Route = {
  owner: Address;
  token: Address;
  amount: bigint;
  depositAddress: Address;
  relayer: Address;
  reimbursementAmount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  transferNonce: Hex;
  routeNonce: Hex;
};
type SignedRoute = {
  token: Address;
  router: Address;
  route: Route;
  transferSignature: Hex;
  routeSignature: Hex;
  routerAbi: Abi;
};

const common: Common = createCustomCommon(
  { name: "zecrescue-local-test", chainId: CHAIN_ID },
  Mainnet,
  { hardfork: Hardfork.Shanghai }
);
let vm: VM;
let block: ReturnType<typeof createBlock>;
let compiled!: { router: CompiledContract; token: CompiledContract };

function compile(): { router: CompiledContract; token: CompiledContract } {
  const sources = Object.fromEntries(["RescueRouter.sol", "MockNativeUSDC.sol"].map((name) => [name, {
    content: readFileSync(join(process.cwd(), "contracts", "src", name), "utf8")
  }]));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  }))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
  };
  const errors = output.errors?.filter((entry) => entry.severity === "error") ?? [];
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  const contract = (file: string, name: string): CompiledContract => {
    const compiledContract = output.contracts[file]?.[name];
    if (!compiledContract?.evm.bytecode.object) throw new Error(`Solidity compilation omitted ${name}`);
    return { abi: compiledContract.abi, bytecode: `0x${compiledContract.evm.bytecode.object}` as Hex };
  };
  return { router: contract("RescueRouter.sol", "RescueRouter"), token: contract("MockNativeUSDC.sol", "MockNativeUSDC") };
}

function splitSignature(signature: Hex): SignatureParts {
  return {
    r: `0x${signature.slice(2, 66)}` as Hex,
    s: `0x${signature.slice(66, 130)}` as Hex,
    v: Number.parseInt(signature.slice(130, 132), 16)
  };
}

function executionData(input: SignedRoute, route = input.route): Uint8Array {
  const transfer = splitSignature(input.transferSignature);
  const routeSig = splitSignature(input.routeSignature);
  const data = encodeFunctionData({
    abi: input.routerAbi,
    functionName: "execute",
    args: [route, transfer.v, transfer.r, transfer.s, routeSig.v, routeSig.r, routeSig.s]
  } as never);
  return hexToBytes(data);
}

async function transaction(
  data: Uint8Array,
  to?: Address,
  senderKey: Hex = RELAYER_KEY
) {
  const sender = createAddressFromPrivateKey(hexToBytes(senderKey));
  const account = await vm.stateManager.getAccount(sender);
  const tx = createLegacyTx({
    nonce: account?.nonce ?? 0n,
    gasLimit: 5_000_000n,
    gasPrice: GAS_PRICE,
    value: 0n,
    ...(to ? { to: createAddressFromString(to) } : {}),
    data
  }, { common }).sign(hexToBytes(senderKey));
  return runTx(vm, { tx, block, skipBlockGasLimitValidation: true });
}

async function deploy(artifact: CompiledContract, constructorArgs: Uint8Array = new Uint8Array()): Promise<Address> {
  const initCode = new Uint8Array([...hexToBytes(artifact.bytecode), ...constructorArgs]);
  const result = await transaction(initCode);
  expect(result.execResult.exceptionError).toBeUndefined();
  if (!result.createdAddress) throw new Error("Local EVM did not return the deployed contract address");
  return result.createdAddress.toString() as Address;
}

async function tokenValue(token: Address, functionName: "balanceOf" | "authorizationState", args: readonly unknown[]): Promise<bigint | boolean> {
  const data = encodeFunctionData({ abi: compiled.token.abi, functionName, args } as never);
  const result = await vm.evm.runCall({
    to: createAddressFromString(token),
    caller: RELAYER_ADDRESS,
    origin: RELAYER_ADDRESS,
    data: hexToBytes(data),
    gasLimit: 1_000_000n,
    block,
    isStatic: true
  });
  if (result.execResult.exceptionError) throw result.execResult.exceptionError;
  const output = bytesToHex(result.execResult.returnValue);
  return functionName === "balanceOf"
    ? decodeAbiParameters([{ type: "uint256" }], output)[0]
    : decodeAbiParameters([{ type: "bool" }], output)[0];
}

async function tokenBalance(token: Address, account: Address): Promise<bigint> {
  return await tokenValue(token, "balanceOf", [account]) as bigint;
}

async function nonceUsed(contract: Address, functionName: "routeNonceUsed" | "authorizationState", args: readonly unknown[], abi: Abi): Promise<boolean> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const result = await vm.evm.runCall({
    to: createAddressFromString(contract),
    caller: RELAYER_ADDRESS,
    origin: RELAYER_ADDRESS,
    data: hexToBytes(data),
    gasLimit: 1_000_000n,
    block,
    isStatic: true
  });
  if (result.execResult.exceptionError) throw result.execResult.exceptionError;
  return decodeAbiParameters([{ type: "bool" }], bytesToHex(result.execResult.returnValue))[0];
}

async function signedRoute(options: { expired?: boolean; future?: boolean; amount?: bigint; reimbursement?: bigint; deposit?: Address } = {}): Promise<SignedRoute> {
  const token = await deploy(compiled.token);
  const tokenConstructorArgs = encodeAbiParameters([{ type: "address" }], [token]);
  const router = await deploy(compiled.router, hexToBytes(tokenConstructorArgs));
  const total = options.amount ?? 10_000_000n;
  const reimbursement = options.reimbursement ?? 50_000n;
  const validAfter = options.expired ? NOW - 500n : options.future ? NOW + 500n : NOW - 2n;
  const validBefore = options.expired ? NOW - 200n : options.future ? NOW + 800n : NOW + 120n;
  const transferNonce = `0x${"ab".repeat(32)}` as Hex;
  const routeNonce = `0x${"cd".repeat(32)}` as Hex;
  const route: Route = {
    owner: VICTIM.address,
    token,
    amount: total,
    depositAddress: options.deposit ?? DEPOSIT,
    relayer: RELAYER.address,
    reimbursementAmount: reimbursement,
    validAfter,
    validBefore,
    transferNonce,
    routeNonce
  };
  const mintData = encodeFunctionData({ abi: compiled.token.abi, functionName: "mint", args: [VICTIM.address, total] } as never);
  expectSuccess(await transaction(hexToBytes(mintData), token));
  const transferSignature = await VICTIM.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: token },
    types: transferTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: VICTIM.address,
      to: router,
      value: total,
      validAfter,
      validBefore,
      nonce: transferNonce
    }
  });
  const routeSignature = await VICTIM.signTypedData({
    domain: { name: "ZecRescue RescueRouter", version: "1", chainId: CHAIN_ID, verifyingContract: router },
    types: routeTypes,
    primaryType: "RescueRoute",
    message: route
  });
  return { token, router, route, transferSignature, routeSignature, routerAbi: compiled.router.abi };
}

function expectedError(result: Awaited<ReturnType<typeof runTx>>, signature: string) {
  expect(result.execResult.exceptionError).toBeDefined();
  expect(bytesToHex(result.execResult.returnValue).slice(0, 10)).toBe(toFunctionSelector(signature));
}

async function execute(input: SignedRoute, route = input.route, senderKey: Hex = RELAYER_KEY) {
  return transaction(executionData(input, route), input.router, senderKey);
}

function expectSuccess(result: Awaited<ReturnType<typeof runTx>>) {
  expect(result.execResult.exceptionError).toBeUndefined();
}

describe("non-custodial rescue reimbursement router", () => {
  beforeEach(async () => {
    compiled ??= compile();
    vm = await createVM({ common, activatePrecompiles: true });
    await vm.stateManager.putAccount(VICTIM_ADDRESS, createAccount({ nonce: 0n, balance: 0n }));
    await vm.stateManager.putAccount(RELAYER_ADDRESS, createAccount({ nonce: 0n, balance: 10n ** 20n }));
    await vm.stateManager.putAccount(ATTACKER_ADDRESS, createAccount({ nonce: 0n, balance: 10n ** 18n }));
    block = createBlock({ header: { number: 1n, timestamp: NOW, gasLimit: 30_000_000n, baseFeePerGas: 0n } }, {
      common,
      skipConsensusFormatValidation: true
    });
  }, 30_000);

  it("atomically reimburses the signed relayer and forwards the exact remainder", async () => {
    const input = await signedRoute();
    const victimNativeBefore = (await vm.stateManager.getAccount(VICTIM_ADDRESS))!.balance;
    const relayerNativeBefore = (await vm.stateManager.getAccount(RELAYER_ADDRESS))!.balance;
    const receipt = await execute(input);

    expectSuccess(receipt);
    expect(await tokenBalance(input.token, VICTIM.address)).toBe(0n);
    expect(await tokenBalance(input.token, input.router)).toBe(0n);
    expect(await tokenBalance(input.token, input.route.depositAddress)).toBe(9_950_000n);
    expect(await tokenBalance(input.token, input.route.relayer)).toBe(50_000n);
    expect((await vm.stateManager.getAccount(VICTIM_ADDRESS))!.balance).toBe(victimNativeBefore);
    expect((await vm.stateManager.getAccount(RELAYER_ADDRESS))!.balance).toBeLessThan(relayerNativeBefore);
    expect(receipt.totalGasSpent).toBeGreaterThan(0n);
    expect(await nonceUsed(input.router, "routeNonceUsed", [VICTIM.address, input.route.routeNonce], input.routerAbi)).toBe(true);
    expect(await nonceUsed(input.token, "authorizationState", [VICTIM.address, input.route.transferNonce], compiled.token.abi)).toBe(true);

    // Same data, nonce, signatures, and destination. The route nonce check must
    // reject before the token is called, while the original auth is still live.
    expectedError(await execute(input), "RouteAlreadyUsed()");
  });

  it("rejects route edits and caller substitution", async () => {
    const input = await signedRoute();
    expectedError(await execute(input, { ...input.route, depositAddress: OTHER }), "InvalidRouteSignature()");
    expectedError(await execute(input, { ...input.route, amount: input.route.amount - 1n }), "InvalidRouteSignature()");
    expectedError(await execute(input, input.route, ATTACKER_KEY), "InvalidRoute()");
    expect(await tokenBalance(input.token, VICTIM.address)).toBe(input.route.amount);

    const wrongChainSignature = await VICTIM.signTypedData({
      domain: { name: "ZecRescue RescueRouter", version: "1", chainId: CHAIN_ID + 1, verifyingContract: input.router },
      types: routeTypes,
      primaryType: "RescueRoute",
      message: input.route
    });
    expectedError(await execute({ ...input, routeSignature: wrongChainSignature }), "InvalidRouteSignature()");
  });

  it("rejects expired and overlong authorizations", async () => {
    const expired = await signedRoute({ expired: true });
    expectedError(await execute(expired), "RouteExpired()");
    expect(await tokenBalance(expired.token, VICTIM.address)).toBe(expired.route.amount);

    const long = await signedRoute();
    const longRoute = { ...long.route, validBefore: long.route.validAfter + 301n };
    const longTransferSignature = await VICTIM.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: long.token },
      types: transferTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: VICTIM.address,
        to: long.router,
        value: longRoute.amount,
        validAfter: longRoute.validAfter,
        validBefore: longRoute.validBefore,
        nonce: longRoute.transferNonce
      }
    });
    const longRouteSignature = await VICTIM.signTypedData({
      domain: { name: "ZecRescue RescueRouter", version: "1", chainId: CHAIN_ID, verifyingContract: long.router },
      types: routeTypes,
      primaryType: "RescueRoute",
      message: longRoute
    });
    expectedError(await execute({ ...long, route: longRoute, transferSignature: longTransferSignature, routeSignature: longRouteSignature }), "InvalidWindow()");

    const deferred = await signedRoute({ future: true });
    expectedError(await execute(deferred), "InvalidWindow()");
  });

  it("rolls back token authorization and route nonce if either split transfer fails", async () => {
    const input = await signedRoute();
    const failData = encodeFunctionData({ abi: compiled.token.abi, functionName: "setFailOnTransferCall", args: [2n] } as never);
    expectSuccess(await transaction(hexToBytes(failData), input.token));
    expectedError(await execute(input), "TransferFailed()");
    expect(await tokenBalance(input.token, VICTIM.address)).toBe(input.route.amount);
    expect(await tokenBalance(input.token, input.router)).toBe(0n);
    expect(await nonceUsed(input.router, "routeNonceUsed", [VICTIM.address, input.route.routeNonce], input.routerAbi)).toBe(false);
    expect(await nonceUsed(input.token, "authorizationState", [VICTIM.address, input.route.transferNonce], compiled.token.abi)).toBe(false);
  });

  it("blocks reentrancy from the token callback", async () => {
    const input = await signedRoute();
    const callbackData = executionData(input);
    const setCallback = encodeFunctionData({
      abi: compiled.token.abi,
      functionName: "setCallback",
      args: [input.router, bytesToHex(callbackData)]
    } as never);
    expectSuccess(await transaction(hexToBytes(setCallback), input.token));
    expectedError(await execute(input), "ReentrantCall()");
    expect(await tokenBalance(input.token, VICTIM.address)).toBe(input.route.amount);
    expect(await nonceUsed(input.router, "routeNonceUsed", [VICTIM.address, input.route.routeNonce], input.routerAbi)).toBe(false);
  });

  it("rejects reimbursement that consumes the complete rescued amount", async () => {
    const input = await signedRoute({ amount: 100n, reimbursement: 100n });
    expectedError(await execute(input), "InvalidRoute()");
    expect(await tokenBalance(input.token, VICTIM.address)).toBe(100n);
  });
});
