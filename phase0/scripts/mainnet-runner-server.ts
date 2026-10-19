import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join, resolve, sep } from "node:path";
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  fallback,
  http,
  isAddress,
  isHash,
  parseEventLogs,
  type Address,
  type Hex
} from "viem";
import {
  assessReplayProof,
  AUTHORIZATION_LIFETIME_SECONDS,
  AUTHORIZATION_START_GRACE_SECONDS,
  DEFAULT_TEST_AMOUNT,
  eip3009Abi,
  MAINNET_CHAINS,
  makeMainnetAuthorization,
  newAuthorizationNonce,
  parseDistinctAddresses,
  parseTinyUsdcAmount,
  rpcUrlsForChain,
  transferAuthorizationSelector,
  type MainnetChainKey
} from "../src/mainnet-runner.js";

const PORT = 4179;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT = `${resolve(process.cwd())}${sep}`;
const WEB_ROOT = resolve(process.cwd(), "phase0", "web");

const transferEventAbi = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" }
    ]
  }
] as const;

const authorizationUsedEventAbi = [
  {
    type: "event",
    name: "AuthorizationUsed",
    anonymous: false,
    inputs: [
      { indexed: true, name: "authorizer", type: "address" },
      { indexed: true, name: "nonce", type: "bytes32" }
    ]
  }
] as const;

const selector = transferAuthorizationSelector();
const eip3009TypeProbe = "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)";
if (selector.length !== 10 || !eip3009TypeProbe.startsWith("transferWithAuthorization")) {
  throw new Error("Internal EIP-3009 selector check failed");
}

type JsonRecord = Record<string, unknown>;

function isChainKey(value: unknown): value is MainnetChainKey {
  return value === "base" || value === "arbitrum";
}

function publicClient(chainKey: MainnetChainKey) {
  const transports = rpcUrlsForChain(chainKey).map((url) => http(url, { timeout: 15_000, retryCount: 0 }));
  return createPublicClient({
    transport: transports.length === 1 ? transports[0]! : fallback(transports, { rank: false })
  });
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed";
  if (/fetch failed|http request failed|timed? out|network|socket|econn|enotfound|eai_again/i.test(message)) {
    return "Local EVM RPC request failed. Check BASE_RPC_URL (if set) and network connectivity. RPC endpoints are kept server-side.";
  }
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[RPC endpoint]")
    .replace(/0x[0-9a-fA-F]{64,}/g, "[redacted hex]");
}

function requireCalldata(record: JsonRecord): Hex {
  const value = requireString(record, "calldata");
  if (!/^0x[0-9a-fA-F]{584}$/.test(value)) throw new Error("calldata must be one encoded EIP-3009 transferWithAuthorization call");
  return value as Hex;
}

function json(res: import("node:http").ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<JsonRecord> {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 8_192) throw new Error("Request body is too large");
  }
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as JsonRecord;
}

function requireString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

function containsEvmRevert(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object" && !visited.has(current); depth += 1) {
    visited.add(current);
    const item = current as { message?: unknown; shortMessage?: unknown; cause?: unknown };
    const message = [item.message, item.shortMessage].filter((value): value is string => typeof value === "string").join(" ");
    if (/revert|invalid signature|authorization/i.test(message)) return true;
    current = item.cause;
  }
  return false;
}

function isConsumedAuthorizationNonceRevert(error: unknown): boolean {
  const visited = new Set<object>();
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object" && !visited.has(current); depth += 1) {
    visited.add(current);
    const item = current as { message?: unknown; shortMessage?: unknown; details?: unknown; reason?: unknown; cause?: unknown };
    for (const value of [item.message, item.shortMessage, item.details, item.reason]) {
      if (typeof value === "string") messages.push(value);
    }
    current = item.cause;
  }
  return /authorization(?:\s+nonce)?\s+(?:is|was|has been)\s+(?:used|consumed)(?:\s+or\s+canceled)?|authorization.{0,48}(?:used|consumed|canceled)|nonce.{0,48}(?:used|consumed)/i.test(messages.join(" "));
}

function broadcastGate(chainKey: MainnetChainKey): { enabled: boolean; reason: string } {
  if (chainKey === "base") return { enabled: true, reason: "Base is the only chain enabled for the first micro-test." };
  const basePass = process.env.PHASE0_BASE_MAINNET_PASS === "1";
  const explicitEnable = process.env.PHASE0_ENABLE_ARBITRUM === "1";
  if (basePass && explicitEnable) return { enabled: true, reason: "Arbitrum broadcasting was explicitly enabled after a recorded Base pass." };
  return {
    enabled: false,
    reason: "Dry-run only until Base has passed and both PHASE0_BASE_MAINNET_PASS=1 and PHASE0_ENABLE_ARBITRUM=1 are set."
  };
}

async function handlePreflight(body: JsonRecord): Promise<unknown> {
  const chainKey = body.chainKey;
  if (!isChainKey(chainKey)) throw new Error("chainKey must be base or arbitrum; optimism is deferred");
  const chain = MAINNET_CHAINS[chainKey];
  const { victim, destination, relayer } = parseDistinctAddresses(
    requireString(body, "victim"),
    requireString(body, "destination"),
    requireString(body, "relayer")
  );
  const amount = requireString(body, "amount");
  const value = parseTinyUsdcAmount(amount);
  const client = publicClient(chainKey);
  const chainId = await client.getChainId();
  if (chainId !== chain.chainId) throw new Error(`RPC chain ID mismatch: expected ${chain.chainId}, got ${chainId}`);

  const [latestBlock, code, name, symbol, decimals, version, victimUsdc, destinationUsdc, victimNative, relayerNative, destinationCode, relayerCode] = await Promise.all([
    client.getBlock({ blockTag: "latest" }),
    client.getCode({ address: chain.usdc }),
    client.readContract({ address: chain.usdc, abi: eip3009Abi, functionName: "name" }),
    client.readContract({ address: chain.usdc, abi: eip3009Abi, functionName: "symbol" }),
    client.readContract({ address: chain.usdc, abi: eip3009Abi, functionName: "decimals" }),
    client.readContract({ address: chain.usdc, abi: eip3009Abi, functionName: "version" }),
    client.readContract({ address: chain.usdc, abi: eip3009Abi, functionName: "balanceOf", args: [victim] }),
    client.readContract({ address: chain.usdc, abi: eip3009Abi, functionName: "balanceOf", args: [destination] }),
    client.getBalance({ address: victim }),
    client.getBalance({ address: relayer }),
    client.getCode({ address: destination }),
    client.getCode({ address: relayer })
  ]);

  if (!code || code === "0x") throw new Error("Configured native USDC contract has no code on this chain");
  if (name !== "USD Coin" || symbol !== "USDC" || decimals !== 6 || version !== "2") {
    throw new Error(`Unexpected native USDC metadata: name=${name}, symbol=${symbol}, decimals=${decimals}, EIP-712 version=${version}`);
  }
  if (destinationCode && destinationCode !== "0x") throw new Error("Micro-test destination must be an EOA with no deployed code");
  if (relayerCode && relayerCode !== "0x") throw new Error("Micro-test relayer must be a separate EOA with no deployed code");
  if (victimUsdc < value) throw new Error(`Victim USDC balance ${victimUsdc} is below requested amount ${value}`);

  const nonce = newAuthorizationNonce();
  const nonceUsed = await client.readContract({
    address: chain.usdc,
    abi: eip3009Abi,
    functionName: "authorizationState",
    args: [victim, nonce]
  });
  if (nonceUsed) throw new Error("Fresh authorization nonce unexpectedly appears used");

  const timestamp = latestBlock.timestamp;
  const authorization = makeMainnetAuthorization(victim, destination, value, timestamp, nonce);
  const invalidSignature = {
    functionName: "transferWithAuthorization" as const,
    args: [victim, destination, value, authorization.validAfter, authorization.validBefore, nonce, 27, `0x${"00".repeat(32)}` as Hex, `0x${"00".repeat(32)}` as Hex] as const
  };
  let invalidSignatureReverted = false;
  try {
    await client.call({
      account: relayer,
      to: chain.usdc,
      data: encodeFunctionData({ abi: eip3009Abi, ...invalidSignature })
    });
  } catch (error) {
    if (!containsEvmRevert(error)) throw new Error("Invalid-signature probe did not return an EVM revert; check the RPC and retry");
    invalidSignatureReverted = true;
  }
  if (!invalidSignatureReverted) throw new Error("Invalid-signature EIP-3009 probe unexpectedly succeeded");

  const gate = broadcastGate(chainKey);
  return {
    chain: { key: chain.key, name: chain.name, chainId: chain.chainId },
    token: { address: chain.usdc, name, symbol, decimals, eip712Version: version },
    amount: { display: amount, baseUnits: value.toString() },
    addresses: { victim, destination, relayer },
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
      lifetimeSeconds: AUTHORIZATION_LIFETIME_SECONDS.toString(),
      startGraceSeconds: AUTHORIZATION_START_GRACE_SECONDS.toString()
    },
    domain: { name, version, chainId: chain.chainId, verifyingContract: chain.usdc },
    typedData: {
      primaryType: "TransferWithAuthorization",
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" }
        ],
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" }
        ]
      },
      message: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce
      }
    },
    checks: {
      rpcChainId: chainId,
      tokenCodePresent: true,
      exactNativeUsdcMetadata: true,
      authorizationStateRead: true,
      nonceUnused: true,
      invalidSignatureReverted: true,
      victimUsdcBalance: victimUsdc.toString(),
      destinationUsdcBalance: destinationUsdc.toString(),
      destinationIsEoa: true,
      victimNativeBalance: victimNative.toString(),
      relayerNativeBalance: relayerNative.toString(),
      observedAtBlock: latestBlock.number?.toString() ?? null
    },
    broadcast: gate,
    functionSelector: selector
  };
}

async function handleSubmissionCheck(body: JsonRecord): Promise<unknown> {
  const chainKey = body.chainKey;
  if (!isChainKey(chainKey)) throw new Error("chainKey must be base or arbitrum; optimism is deferred");
  const chain = MAINNET_CHAINS[chainKey];
  const { victim, destination, relayer } = parseDistinctAddresses(
    requireString(body, "victim"),
    requireString(body, "destination"),
    requireString(body, "relayer")
  );
  const amount = BigInt(requireString(body, "amountBaseUnits"));
  if (amount <= 0n || amount > 50_000n) throw new Error("amountBaseUnits is outside the micro-test limit");
  const nonce = requireString(body, "nonce") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("nonce must be 32 bytes");
  const calldata = requireCalldata(body);
  const decoded = decodeFunctionData({ abi: eip3009Abi, data: calldata });
  if (decoded.functionName !== "transferWithAuthorization") throw new Error("calldata is not an EIP-3009 transferWithAuthorization call");
  const [from, to, value, validAfter, validBefore, signedNonce] = decoded.args;
  if (
    from.toLowerCase() !== victim.toLowerCase() ||
    to.toLowerCase() !== destination.toLowerCase() ||
    value !== amount ||
    signedNonce.toLowerCase() !== nonce.toLowerCase()
  ) {
    throw new Error("Signed calldata does not match the selected victim, destination, amount, and nonce");
  }

  const client = publicClient(chainKey);
  const [chainId, latestBlock, nonceUsed, victimNative, relayerNative] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: "latest" }),
    client.readContract({ address: chain.usdc, abi: eip3009Abi, functionName: "authorizationState", args: [victim, nonce as Hex] }),
    client.getBalance({ address: victim }),
    client.getBalance({ address: relayer })
  ]);
  if (chainId !== chain.chainId) throw new Error(`RPC chain ID mismatch: expected ${chain.chainId}, got ${chainId}`);
  if (validAfter > latestBlock.timestamp || validBefore <= latestBlock.timestamp || validBefore <= validAfter) {
    throw new Error("Signed authorization is not currently within its validity window");
  }
  if (validBefore - validAfter > AUTHORIZATION_LIFETIME_SECONDS + AUTHORIZATION_START_GRACE_SECONDS) {
    throw new Error("Signed authorization validity window exceeds the Phase 0 limit");
  }
  if (nonceUsed) throw new Error("Authorization nonce is already used");

  const [estimatedGas, gasPrice] = await Promise.all([
    client.estimateGas({ account: relayer, to: chain.usdc, data: calldata }),
    client.getGasPrice()
  ]);
  await client.call({ account: relayer, to: chain.usdc, data: calldata });
  const feeCushion = estimatedGas * gasPrice * 2n;
  if (relayerNative < feeCushion) {
    throw new Error(`Relayer native balance ${relayerNative} is below the 2x estimated fee cushion ${feeCushion}`);
  }

  return {
    chain: { key: chain.key, name: chain.name, chainId },
    authorization: {
      from,
      to,
      value: value.toString(),
      nonce: signedNonce,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonceUnused: true,
      signatureSimulationPassed: true
    },
    gas: {
      estimatedUnits: estimatedGas.toString(),
      gasPriceWei: gasPrice.toString(),
      estimatedFeeWei: (estimatedGas * gasPrice).toString(),
      requiredBalanceCushionWei: feeCushion.toString()
    },
    balancesBefore: {
      victimNative: victimNative.toString(),
      relayerNative: relayerNative.toString()
    },
    signatureReceivedByLocalRunnerForSimulation: true,
    signaturePersisted: false
  };
}

async function handleVerify(body: JsonRecord): Promise<{ status: number; value: unknown }> {
  const chainKey = body.chainKey;
  if (!isChainKey(chainKey)) throw new Error("chainKey must be base or arbitrum; optimism is deferred");
  const chain = MAINNET_CHAINS[chainKey];
  const txHash = requireString(body, "txHash");
  if (!isHash(txHash)) throw new Error("txHash must be a 32-byte transaction hash");
  const victimText = requireString(body, "victim");
  const destinationText = requireString(body, "destination");
  const relayerText = requireString(body, "relayer");
  if (![victimText, destinationText, relayerText].every((address) => isAddress(address))) throw new Error("Invalid participant address");
  const victim = victimText as Address;
  const destination = destinationText as Address;
  const relayer = relayerText as Address;
  const nonce = requireString(body, "nonce") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("nonce must be 32 bytes");
  const expectedAmount = BigInt(requireString(body, "amountBaseUnits"));
  if (expectedAmount <= 0n || expectedAmount > 50_000n) throw new Error("amountBaseUnits is outside the micro-test limit");
  const calldata = requireCalldata(body);
  const client = publicClient(chainKey);
  if (await client.getChainId() !== chain.chainId) throw new Error("RPC chain ID mismatch");
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash: txHash as Hex }).catch(() => null),
    client.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null)
  ]);
  if (!receipt) return { status: 202, value: { pending: true, message: "Transaction is not mined yet." } };
  if (!transaction) throw new Error("Mined transaction could not be loaded");
  if (receipt.status !== "success") throw new Error("Transaction receipt failed");
  if (transaction.from.toLowerCase() !== relayer.toLowerCase()) throw new Error("Mined transaction sender does not match the relayer");
  if (transaction.to?.toLowerCase() !== chain.usdc.toLowerCase()) throw new Error("Mined transaction target is not native USDC");
  if (transaction.input.toLowerCase() !== calldata.toLowerCase()) {
    throw new Error("Mined transaction input does not match the exact signed calldata");
  }
  const decoded = decodeFunctionData({ abi: eip3009Abi, data: calldata });
  if (decoded.functionName !== "transferWithAuthorization") throw new Error("Mined calldata is not transferWithAuthorization");
  const [signedVictim, signedDestination, signedAmount, , , signedNonce] = decoded.args;
  if (
    signedVictim.toLowerCase() !== victim.toLowerCase() ||
    signedDestination.toLowerCase() !== destination.toLowerCase() ||
    signedAmount !== expectedAmount ||
    signedNonce.toLowerCase() !== nonce.toLowerCase()
  ) {
    throw new Error("Mined calldata does not match the verified victim, destination, amount, and nonce");
  }

  const parsedEvents = parseEventLogs({ abi: transferEventAbi, logs: receipt.logs });
  const transfer = parsedEvents.find((event) =>
    event.eventName === "Transfer" &&
    event.args.from.toLowerCase() === victim.toLowerCase() &&
    event.args.to.toLowerCase() === destination.toLowerCase() &&
    event.args.value === expectedAmount
  );
  if (!transfer) throw new Error("Receipt does not contain the exact victim-to-destination USDC Transfer event");

  const authorizationEvents = parseEventLogs({ abi: authorizationUsedEventAbi, logs: receipt.logs });
  const authorizationUse = authorizationEvents.find((event) =>
    event.eventName === "AuthorizationUsed" &&
    event.args.authorizer.toLowerCase() === victim.toLowerCase() &&
    event.args.nonce.toLowerCase() === nonce.toLowerCase()
  );
  if (!authorizationUse) throw new Error("Receipt does not contain AuthorizationUsed for the exact victim and nonce");

  const [authorizationUsed, victimUsdcAfter, destinationUsdcAfter, victimNativeAfter, relayerNativeAfter, receiptBlock] = await Promise.all([
    client.readContract({ address: chain.usdc, abi: eip3009Abi, functionName: "authorizationState", args: [victim, nonce], blockNumber: receipt.blockNumber }),
    client.readContract({ address: chain.usdc, abi: eip3009Abi, functionName: "balanceOf", args: [victim] }),
    client.readContract({ address: chain.usdc, abi: eip3009Abi, functionName: "balanceOf", args: [destination] }),
    client.getBalance({ address: victim }),
    client.getBalance({ address: relayer }),
    client.getBlock({ blockNumber: receipt.blockNumber })
  ]);

  const effectiveGasPrice = receipt.effectiveGasPrice;
  const executionFee = effectiveGasPrice === undefined ? null : (receipt.gasUsed * effectiveGasPrice).toString();
  return {
    status: 200,
    value: {
      pending: false,
      chain: { key: chain.key, name: chain.name, chainId: chain.chainId },
      txHash,
      txFrom: transaction.from,
      txTo: transaction.to,
      receiptStatus: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: effectiveGasPrice?.toString() ?? null,
      executionFeeWei: executionFee,
      executionFeeNote: "gasUsed × effectiveGasPrice is the receipt execution component; compare account balance deltas for total observed relayer spend, including chain-specific fees.",
      transferEvent: {
        from: transfer.args.from,
        to: transfer.args.to,
        value: transfer.args.value.toString()
      },
      authorizationUsedEvent: {
        authorizer: authorizationUse.args.authorizer,
        nonce: authorizationUse.args.nonce
      },
      authorizationUsed,
      receiptBlockNumber: receipt.blockNumber.toString(),
      receiptBlockTimestamp: receiptBlock.timestamp.toString(),
      balancesAfter: {
        victimUsdc: victimUsdcAfter.toString(),
        destinationUsdc: destinationUsdcAfter.toString(),
        victimNative: victimNativeAfter.toString(),
        relayerNative: relayerNativeAfter.toString()
      }
    }
  };
}

async function handleReplayCheck(body: JsonRecord): Promise<{ status: number; value: unknown }> {
  const verified = await handleVerify(body);
  if (verified.status !== 200) return verified;
  const chainKey = body.chainKey;
  if (!isChainKey(chainKey)) throw new Error("chainKey must be base or arbitrum; optimism is deferred");
  const chain = MAINNET_CHAINS[chainKey];
  const relayer = requireString(body, "relayer") as Address;
  const calldata = requireCalldata(body);
  const decoded = decodeFunctionData({ abi: eip3009Abi, data: calldata });
  if (decoded.functionName !== "transferWithAuthorization") throw new Error("calldata is not an EIP-3009 transferWithAuthorization call");
  const validAfter = decoded.args[3];
  const validBefore = decoded.args[4];
  const verifiedBody = verified.value as {
    authorizationUsed: boolean;
    receiptBlockNumber: string;
    receiptBlockTimestamp: string;
  };
  let replayRejected = false;
  let revertIdentifiesConsumedNonce = false;
  const replayBlockNumber = BigInt(verifiedBody.receiptBlockNumber);
  try {
    await publicClient(chainKey).call({ account: relayer, to: chain.usdc, data: calldata, blockNumber: replayBlockNumber });
  } catch (error) {
    if (!containsEvmRevert(error)) throw error;
    replayRejected = true;
    revertIdentifiesConsumedNonce = isConsumedAuthorizationNonceRevert(error);
  }
  const proof = assessReplayProof({
    blockTimestamp: BigInt(verifiedBody.receiptBlockTimestamp),
    validAfter,
    validBefore,
    authorizationUsed: verifiedBody.authorizationUsed,
    replayRejected,
    revertIdentifiesConsumedNonce
  });
  return {
    status: 200,
    value: {
      replayRejected,
      authorizationUsed: verifiedBody.authorizationUsed,
      authorizationInsideOriginalWindow: proof.authorizationInsideOriginalWindow,
      replayRejectedByConsumedNonce: proof.replayRejectedByConsumedNonce,
      revertIdentifiesConsumedNonce,
      replayBlockNumber: verifiedBody.receiptBlockNumber,
      replayBlockTimestamp: verifiedBody.receiptBlockTimestamp,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      replayTransactionBroadcast: false,
      pass: proof.pass
    }
  };
}

async function serveFile(path: string): Promise<Buffer> {
  const allowed: Record<string, string> = {
    "/": join(WEB_ROOT, "mainnet-test.html"),
    "/mainnet-test.html": join(WEB_ROOT, "mainnet-test.html"),
    "/runner.js": join(WEB_ROOT, "runner.js"),
    "/eip3009.js": join(WEB_ROOT, "eip3009.js")
  };
  const file = allowed[path];
  if (!file || !file.startsWith(ROOT)) throw new Error("Not found");
  return readFile(file);
}

const server = createServer(async (req, res) => {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${PORT}`) return json(res, 403, { error: "Use http://127.0.0.1:4179 only" });
  const url = new URL(req.url ?? "/", ORIGIN);
  const isApi = url.pathname.startsWith("/api/");
  if (isApi && req.method !== "GET" && req.headers.origin !== ORIGIN) return json(res, 403, { error: "Same-origin requests only" });

  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      const chains = Object.values(MAINNET_CHAINS).map((chain) => ({
        key: chain.key,
        name: chain.name,
        chainId: chain.chainId,
        usdc: chain.usdc,
        broadcast: broadcastGate(chain.key)
      }));
      return json(res, 200, { chains, defaultAmount: DEFAULT_TEST_AMOUNT, minAmount: "0.000001", maxAmount: "0.05", lifetimeSeconds: "300" });
    }
    if (req.method === "POST" && url.pathname === "/api/preflight") {
      const body = await readJson(req);
      return json(res, 200, await handlePreflight(body));
    }
    if (req.method === "POST" && url.pathname === "/api/submission-check") {
      const body = await readJson(req);
      return json(res, 200, await handleSubmissionCheck(body));
    }
    if (req.method === "POST" && url.pathname === "/api/verify") {
      const body = await readJson(req);
      const result = await handleVerify(body);
      return json(res, result.status, result.value);
    }
    if (req.method === "POST" && url.pathname === "/api/replay-check") {
      const body = await readJson(req);
      const result = await handleReplayCheck(body);
      return json(res, result.status, result.value);
    }
    if (req.method === "GET" && !isApi) {
      const body = await serveFile(url.pathname);
      const contentType = url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
      res.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      });
      return res.end(body);
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 400, { error: safeErrorMessage(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Phase 0 mainnet runner listening at ${ORIGIN}`);
  console.log(process.env.BASE_RPC_URL?.trim()
    ? "Base RPC: using server-side BASE_RPC_URL with the official public endpoint as fallback; endpoint omitted."
    : "Base RPC: using the official public endpoint; BASE_RPC_URL may override it server-side.");
  console.log("EVM reads and simulations stay in this loopback server; wallet connection, signing, and transaction submission stay in the wallet.");
});
