// Legacy Base Sepolia-only harness from the earlier spike.
// It is not admissible evidence for the mainnet-only project and must not be run as a proof.
import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseSignature,
  type Address,
  type Hex
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { makeAuthorization, transferAuthorizationTypes } from "../src/eip3009.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const AUTHORIZATION_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.PHASE0_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
  const victimAccount = privateKeyToAccount(generatePrivateKey());
  const relayerAccount = privateKeyToAccount(generatePrivateKey());
  const recipientAccount = privateKeyToAccount(generatePrivateKey());
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const relayerClient = createWalletClient({ account: relayerAccount, chain: baseSepolia, transport: http(rpcUrl) });

  async function waitForFunds(): Promise<void> {
    console.log(`Victim test address: ${victimAccount.address}`);
    console.log(`Relayer test address: ${relayerAccount.address}`);
    console.log("Fund only with Sepolia test ETH and Circle Sepolia USDC. Keys remain in process memory.");
    const deadline = Date.now() + 60 * 60_000;
    while (Date.now() < deadline) {
      const [victimUsdc, relayerEth] = await Promise.all([
        publicClient.readContract({ address: USDC, abi: AUTHORIZATION_ABI, functionName: "balanceOf", args: [victimAccount.address] }),
        publicClient.getBalance({ address: relayerAccount.address })
      ]);
      console.log(`Funds: victim USDC=${victimUsdc} (need >= 2000000), relayer ETH=${relayerEth} (need >= 1000000000000000)`);
      if (victimUsdc >= 2_000_000n && relayerEth >= 1_000_000_000_000_000n) return;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    throw new Error("Timed out waiting for testnet USDC/ETH; no transactions were sent");
  }

  const actualChainId = await publicClient.getChainId();
  assert(actualChainId === 84532, `Expected Base Sepolia (84532), got ${actualChainId}`);
  await waitForFunds();

  const amount = 1_000_000n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const authorization = makeAuthorization(
    victimAccount.address,
    recipientAccount.address,
    amount,
    now - 5n,
    nonce,
    300n
  );
  const signature = await victimAccount.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: USDC },
    types: transferAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: authorization
  });
  const { v, r, s } = parseSignature(signature);
  assert(v !== undefined, "Signature missing recovery id");

  const args = [
    authorization.from,
    authorization.to,
    authorization.value,
    authorization.validAfter,
    authorization.validBefore,
    authorization.nonce,
    Number(v),
    r,
    s
  ] as const;
  const data = encodeFunctionData({ abi: AUTHORIZATION_ABI, functionName: "transferWithAuthorization", args });

  // Signature binds amount and destination. These failures are simulated without broadcasting.
  for (const [label, changedArgs] of [
    ["changed amount", [...args.slice(0, 2), args[2] + 1n, ...args.slice(3)]],
    ["changed destination", [args[0], privateKeyToAccount(generatePrivateKey()).address, ...args.slice(2)]]
  ] as const) {
    let rejected = false;
    try {
      await publicClient.call({ account: relayerAccount.address, to: USDC, data: encodeFunctionData({
        abi: AUTHORIZATION_ABI,
        functionName: "transferWithAuthorization",
        args: changedArgs as typeof args
      }) });
    } catch {
      rejected = true;
    }
    assert(rejected, `Authorization unexpectedly accepted ${label}`);
  }

  const victimEthBefore = await publicClient.getBalance({ address: victimAccount.address });
  const relayerEthBefore = await publicClient.getBalance({ address: relayerAccount.address });
  const victimUsdcBefore = await publicClient.readContract({ address: USDC, abi: AUTHORIZATION_ABI, functionName: "balanceOf", args: [victimAccount.address] });
  const recipientUsdcBefore = await publicClient.readContract({ address: USDC, abi: AUTHORIZATION_ABI, functionName: "balanceOf", args: [recipientAccount.address] });

  const validHash = await relayerClient.sendTransaction({ to: USDC, data, gas: 200_000n });
  const validReceipt = await publicClient.waitForTransactionReceipt({ hash: validHash });
  assert(validReceipt.status === "success", "Valid authorization transaction reverted");

  const victimEthAfter = await publicClient.getBalance({ address: victimAccount.address });
  const relayerEthAfter = await publicClient.getBalance({ address: relayerAccount.address });
  const victimUsdcAfter = await publicClient.readContract({ address: USDC, abi: AUTHORIZATION_ABI, functionName: "balanceOf", args: [victimAccount.address] });
  const recipientUsdcAfter = await publicClient.readContract({ address: USDC, abi: AUTHORIZATION_ABI, functionName: "balanceOf", args: [recipientAccount.address] });
  const consumed = await publicClient.readContract({ address: USDC, abi: AUTHORIZATION_ABI, functionName: "authorizationState", args: [victimAccount.address, nonce] });

  assert(victimEthAfter === victimEthBefore, "Victim native balance changed during the rescue transaction");
  assert(victimUsdcBefore - victimUsdcAfter === amount, "Victim USDC balance delta did not equal the signed amount");
  assert(recipientUsdcAfter - recipientUsdcBefore === amount, "Recipient USDC balance delta did not equal the signed amount");
  assert(relayerEthAfter < relayerEthBefore, "Relayer native balance did not decrease");
  assert(consumed, "Nonce was not marked consumed");

  // Broadcast a replay with an explicit gas limit so the token contract itself rejects it.
  const replayHash = await relayerClient.sendTransaction({ to: USDC, data, gas: 200_000n });
  const replayReceipt = await publicClient.waitForTransactionReceipt({ hash: replayHash });
  assert(replayReceipt.status === "reverted", "Replayed authorization did not revert");

  // Broadcast an expired authorization with a fresh nonce; no USDC can be transferred.
  const expiredNonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const expiredAuthorization = {
    ...makeAuthorization(victimAccount.address, recipientAccount.address, amount, 1n, expiredNonce, 300n),
    validBefore: now - 1n
  };
  const expiredSignature = await victimAccount.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: USDC },
    types: transferAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: expiredAuthorization
  });
  const expiredParts = parseSignature(expiredSignature);
  assert(expiredParts.v !== undefined, "Expired signature missing recovery id");
  const expiredData = encodeFunctionData({
    abi: AUTHORIZATION_ABI,
    functionName: "transferWithAuthorization",
    args: [
      expiredAuthorization.from,
      expiredAuthorization.to,
      expiredAuthorization.value,
      expiredAuthorization.validAfter,
      expiredAuthorization.validBefore,
      expiredAuthorization.nonce,
      Number(expiredParts.v),
      expiredParts.r,
      expiredParts.s
    ]
  });
  const expiredHash = await relayerClient.sendTransaction({ to: USDC, data: expiredData, gas: 200_000n });
  const expiredReceipt = await publicClient.waitForTransactionReceipt({ hash: expiredHash });
  assert(expiredReceipt.status === "reverted", "Expired authorization did not revert");

  console.log(JSON.stringify({
    result: "PASS",
    chain: "Base Sepolia",
    chainId: actualChainId,
    token: USDC,
    amount: amount.toString(),
    recipient: recipientAccount.address,
    victimNativeGasBalanceUnchanged: true,
    relayerPaidNativeGas: true,
    amountAndDestinationMutationRejected: true,
    expiredAuthorizationReverted: true,
    replayReverted: true,
    nonceConsumed: consumed,
    validTx: validHash,
    replayTx: replayHash,
    expiredTx: expiredHash,
    keys: "ephemeral in-memory only; not persisted"
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
