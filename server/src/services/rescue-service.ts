import { randomBytes, randomUUID } from "node:crypto";
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex
} from "viem";
import { estimateL1Fee, estimateOperatorFee } from "viem/op-stack";
import { getRelayerForChain } from "../config/relayer.js";
import {
  AUTHORIZATION_TTL_SECONDS,
  getPublicClient,
  minimumRescueUsdcBaseUnits,
  RESCUE_CHAINS,
  routerSettingsForChain,
  V1_CHAIN_KEYS,
  type ChainKey
} from "../config/chains.js";
import {
  authorizationMatches,
  eip3009Types,
  makeTransferAuthorization,
  recoverAuthorizationSigner,
  restoreAuthorization,
  signatureParts,
  storeAuthorization,
  type PreparedAuthorization,
  type TransferAuthorization
} from "../domain/authorization.js";
import {
  recoverRescueRouteSigner,
  rescueRouteDomain,
  rescueRouteMatches,
  rescueRouteTypes,
  restoreRescueRoute,
  storeRescueRoute,
  type RescueRoute
} from "../domain/rescue-route.js";
import {
  canTransitionLeg,
  type IntentQuoteSnapshot,
  type LegStatus,
  type RescueJob,
  type RescueLeg
} from "../domain/jobs.js";
import { summarizeWorkflow } from "../domain/workflow.js";
import { nativeUsdcAbi } from "../evm/native-usdc-abi.js";
import { rescueRouterAbi } from "../evm/rescue-router-abi.js";
import { isMainnetTransparentP2pkhAddress } from "../domain/zcash-address.js";
import type { RescueJobRepository } from "../repositories/rescue-job-repository.js";
import { parseSourceAddress, scanChainBalance, scanNativeUsdc } from "./balance-scanner.js";
import {
  NearIntentsClient,
  NearIntentsError,
  type NearIntentsGateway,
  type NearToken,
  type SignedNearQuote
} from "./near-intents-client.js";

export class RescueServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: Record<string, string>
  ) {
    super(code);
    this.name = "RescueServiceError";
  }
}

export type CreateJobInput = {
  sourceAddress: string;
  cleanRefundAddress: string;
  selectedChains: readonly ChainKey[];
  idempotencyKey: string;
};

export type CreateRecoveryWorkflowInput = Omit<CreateJobInput, "selectedChains">;

export type PrepareAuthorizationInput = { reimbursementAmountBaseUnits: string };

export type CreateIntentQuoteInput = {
  amountBaseUnits: string;
  zcashRecipient: string;
};

export type SubmitAuthorizationInput = {
  signature: Hex;
  routeSignature: Hex;
  idempotencyKey: string;
};

function hashIdempotencyKey(value: string): Hex {
  if (value.length < 16 || value.length > 128) {
    throw new RescueServiceError(400, "INVALID_IDEMPOTENCY_KEY");
  }
  return keccak256(toBytes(value));
}

function getLeg(job: RescueJob, chainKey: ChainKey): RescueLeg {
  const leg = job.legs.find((item) => item.chainKey === chainKey);
  if (!leg) throw new RescueServiceError(404, "CHAIN_LEG_NOT_FOUND");
  return leg;
}

function preparedFromStored(chainKey: ChainKey, authorization: TransferAuthorization): PreparedAuthorization {
  const config = RESCUE_CHAINS[chainKey];
  return {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: config.chain.id,
      verifyingContract: config.usdc
    },
    primaryType: "TransferWithAuthorization",
    types: eip3009Types,
    message: authorization
  };
}

function assertAuthorizationWindow(authorization: TransferAuthorization, blockTimestamp: bigint): void {
  if (authorization.validAfter > blockTimestamp || authorization.validBefore <= blockTimestamp) {
    throw new RescueServiceError(409, "AUTHORIZATION_EXPIRED_OR_NOT_YET_VALID");
  }
  if (authorization.validBefore <= authorization.validAfter ||
      authorization.validBefore - authorization.validAfter > AUTHORIZATION_TTL_SECONDS) {
    throw new RescueServiceError(400, "AUTHORIZATION_WINDOW_TOO_LONG");
  }
}

export class RescueService {
  constructor(
    private readonly repository: RescueJobRepository,
    private readonly nearIntents: NearIntentsGateway = new NearIntentsClient()
  ) {}

  async scan(sourceAddress: string) {
    if (!isAddress(sourceAddress, { strict: false })) throw new RescueServiceError(400, "INVALID_SOURCE_ADDRESS");
    return scanNativeUsdc(sourceAddress, V1_CHAIN_KEYS);
  }

  async createIntentQuote(jobId: string, chainKey: ChainKey, input: CreateIntentQuoteInput) {
    const job = await this.getJob(jobId);
    const leg = getLeg(job, chainKey);
    if (!/^[0-9]{1,78}$/.test(input.amountBaseUnits)) throw new RescueServiceError(400, "INVALID_AMOUNT_BASE_UNITS");
    const amountBaseUnits = BigInt(input.amountBaseUnits);
    if (amountBaseUnits <= 0n || amountBaseUnits > BigInt(leg.balanceAtScanBaseUnits)) {
      throw new RescueServiceError(400, "AMOUNT_EXCEEDS_SCANNED_BALANCE");
    }
    const minimumAmount = minimumRescueUsdcBaseUnits();
    if (amountBaseUnits < minimumAmount) {
      throw new RescueServiceError(422, "BELOW_MINIMUM_RESCUE_AMOUNT", { minimumAmountBaseUnits: minimumAmount.toString() });
    }
    if (!isMainnetTransparentP2pkhAddress(input.zcashRecipient)) {
      throw new RescueServiceError(400, "TRANSPARENT_MAINNET_ZCASH_RECIPIENT_REQUIRED");
    }

    if (leg.status === "quoted" && leg.intentQuote) {
      if (quoteExpiry(leg.intentQuote).getTime() > Date.now()) {
        throw new RescueServiceError(409, "ACTIVE_QUOTE_ALREADY_EXISTS");
      }
      const expired = await this.repository.updateLeg(jobId, chainKey, ["quoted"], { status: "quote_expired" });
      if (!expired) throw new RescueServiceError(409, "LEG_STATE_CHANGED");
    }
    const current = await this.getJob(jobId);
    const currentLeg = getLeg(current, chainKey);
    if (currentLeg.status !== "discovered" && currentLeg.status !== "quote_expired") {
      throw new RescueServiceError(409, "LEG_NOT_QUOTABLE");
    }

    const config = RESCUE_CHAINS[chainKey];
    let signedQuote: SignedNearQuote;
    try {
      const tokens = await this.nearIntents.getTokens();
      const originAsset = exactUsdcAsset(tokens, chainKey, config.usdc);
      const zecAsset = exactZecAsset(tokens);
      signedQuote = await this.nearIntents.requestQuote({
        amount: amountBaseUnits.toString(),
        originAsset: originAsset.assetId,
        destinationAsset: zecAsset.assetId,
        refundTo: job.cleanRefundAddress,
        recipient: input.zcashRecipient,
        deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      });
      validateSignedQuote(signedQuote, {
        originAsset: originAsset.assetId,
        destinationAsset: zecAsset.assetId,
        amount: amountBaseUnits.toString(),
        refundTo: job.cleanRefundAddress,
        recipient: input.zcashRecipient
      });
    } catch (error) {
      if (error instanceof RescueServiceError) throw error;
      if (error instanceof NearIntentsError) {
        if (error.code === "MINIMUM_AMOUNT_NOT_MET" && error.minimumAmountInBaseUnits) {
          throw new RescueServiceError(422, error.code, { minimumAmountBaseUnits: error.minimumAmountInBaseUnits });
        }
        throw new RescueServiceError(502, error.code);
      }
      throw new RescueServiceError(502, "NEAR_INTENTS_UNAVAILABLE");
    }

    const depositAddress = signedQuote.quote.depositAddress;
    if (!isAddress(depositAddress, { strict: false })) throw new RescueServiceError(502, "INVALID_PROVIDER_DEPOSIT_ADDRESS");
    if (BigInt(signedQuote.quote.amountIn) !== amountBaseUnits) {
      throw new RescueServiceError(502, "PROVIDER_INPUT_AMOUNT_MISMATCH");
    }
    const deadline = validDate(signedQuote.quote.deadline ?? signedQuote.quoteRequest.deadline);
    const timeWhenInactive = signedQuote.quote.timeWhenInactive
      ? validDate(signedQuote.quote.timeWhenInactive)
      : undefined;
    const snapshot: IntentQuoteSnapshot = {
      correlationId: signedQuote.correlationId,
      depositAddress: getAddress(depositAddress),
      ...(signedQuote.quote.depositMemo ? { depositMemo: signedQuote.quote.depositMemo } : {}),
      requestedAmountBaseUnits: amountBaseUnits.toString(),
      slippageToleranceBps: 100,
      amountInBaseUnits: signedQuote.quote.amountIn,
      ...(signedQuote.quote.minAmountIn ? { minimumAmountInBaseUnits: signedQuote.quote.minAmountIn } : {}),
      amountOutBaseUnits: signedQuote.quote.amountOut,
      ...(signedQuote.quote.minAmountOut ? { minimumAmountOutBaseUnits: signedQuote.quote.minAmountOut } : {}),
      ...(signedQuote.quote.amountInFormatted ? { amountInFormatted: signedQuote.quote.amountInFormatted } : {}),
      ...(signedQuote.quote.amountOutFormatted ? { amountOutFormatted: signedQuote.quote.amountOutFormatted } : {}),
      ...(signedQuote.quote.amountInUsd ? { amountInUsd: signedQuote.quote.amountInUsd } : {}),
      ...(signedQuote.quote.amountOutUsd ? { amountOutUsd: signedQuote.quote.amountOutUsd } : {}),
      ...(signedQuote.quote.refundFee ? { refundFeeBaseUnits: signedQuote.quote.refundFee } : {}),
      ...(signedQuote.quote.withdrawFee ? { withdrawFeeBaseUnits: signedQuote.quote.withdrawFee } : {}),
      deadline,
      ...(timeWhenInactive ? { timeWhenInactive } : {}),
      ...(signedQuote.quote.timeEstimate !== undefined ? { timeEstimateSeconds: signedQuote.quote.timeEstimate } : {})
    };
    if (snapshot.minimumAmountInBaseUnits && amountBaseUnits < BigInt(snapshot.minimumAmountInBaseUnits)) {
      throw new RescueServiceError(422, "MINIMUM_AMOUNT_NOT_MET", {
        minimumAmountBaseUnits: snapshot.minimumAmountInBaseUnits
      });
    }
    if (quoteExpiry(snapshot).getTime() <= Date.now() + Number(AUTHORIZATION_TTL_SECONDS) * 1000 + 30_000) {
      throw new RescueServiceError(409, "QUOTE_TOO_CLOSE_TO_EXPIRY");
    }
    const expectedStatuses = currentLeg.status === "discovered" ? ["discovered"] as const : ["quote_expired"] as const;
    const updated = await this.repository.updateLeg(jobId, chainKey, expectedStatuses, {
      status: "quoted",
      amountBaseUnits: amountBaseUnits.toString(),
      destination: snapshot.depositAddress as Address,
      intentQuote: snapshot,
      lastErrorCode: null,
      providerStatus: null
    });
    if (!updated) throw new RescueServiceError(409, "LEG_STATE_CHANGED");
    return {
      jobId,
      chain: { key: chainKey, chainId: config.chain.id, token: config.usdc },
      recipient: input.zcashRecipient,
      recipientType: "transparent-mainnet-zcash",
      refundTo: job.cleanRefundAddress,
      refundType: "ORIGIN_CHAIN",
      quoteVerified: true,
      quote: serializeIntentQuote(snapshot)
    };
  }

  async createJob(input: CreateJobInput): Promise<{ job: RescueJob; created: boolean }> {
    if (!isAddress(input.sourceAddress, { strict: false })) throw new RescueServiceError(400, "INVALID_SOURCE_ADDRESS");
    const sourceAddress = parseSourceAddress(input.sourceAddress);
    if (!isAddress(input.cleanRefundAddress, { strict: false })) throw new RescueServiceError(400, "INVALID_REFUND_ADDRESS");
    const cleanRefundAddress = getAddress(input.cleanRefundAddress);
    if (sourceAddress.toLowerCase() === cleanRefundAddress.toLowerCase()) {
      throw new RescueServiceError(400, "REFUND_ADDRESS_MUST_DIFFER_FROM_SOURCE");
    }
    if (!input.selectedChains.length || new Set(input.selectedChains).size !== input.selectedChains.length) {
      throw new RescueServiceError(400, "INVALID_SELECTED_CHAINS");
    }
    const idempotencyHash = hashIdempotencyKey(input.idempotencyKey);
    const existing = await this.repository.findByCreateIdempotency(sourceAddress, idempotencyHash);
    if (existing) return { job: existing, created: false };

    const balances = await Promise.all(input.selectedChains.map((chainKey) => scanChainBalance(sourceAddress, chainKey)));
    const now = new Date();
    const job: RescueJob = {
      jobId: randomUUID(),
      createIdempotencyKeyHash: idempotencyHash,
      sourceAddress: sourceAddress.toLowerCase() as Address,
      cleanRefundAddress: cleanRefundAddress.toLowerCase() as Address,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      legs: balances.map((balance) => ({
        chainKey: balance.chainKey,
        chainId: balance.chainId,
        tokenAddress: balance.tokenAddress,
        balanceAtScanBaseUnits: balance.balanceBaseUnits,
        status: balance.status === "available" ? "discovered" : "failed",
        ...(balance.errorCode ? { lastErrorCode: balance.errorCode } : {}),
        updatedAt: now
      }))
    };
    try {
      return { job: await this.repository.create(job), created: true };
    } catch (error) {
      const raced = await this.repository.findByCreateIdempotency(sourceAddress, idempotencyHash);
      if (raced) return { job: raced, created: false };
      throw error;
    }
  }

  async createRecoveryWorkflow(input: CreateRecoveryWorkflowInput): Promise<{ job: RescueJob; created: boolean }> {
    return this.createJob({ ...input, selectedChains: V1_CHAIN_KEYS });
  }

  async getJob(jobId: string): Promise<RescueJob> {
    const job = await this.repository.get(jobId);
    if (!job) throw new RescueServiceError(404, "RESCUE_JOB_NOT_FOUND");
    return job;
  }

  async prepareAuthorization(jobId: string, chainKey: ChainKey, input: PrepareAuthorizationInput) {
    const job = await this.getJob(jobId);
    const leg = getLeg(job, chainKey);
    if (leg.status !== "quoted" || !leg.intentQuote) throw new RescueServiceError(409, "LEG_NOT_PREPARABLE");
    const quote = leg.intentQuote;
    const latestUsableTime = Date.now() + Number(AUTHORIZATION_TTL_SECONDS) * 1000 + 30_000;
    if (quoteExpiry(quote).getTime() <= latestUsableTime) {
      await this.repository.updateLeg(jobId, chainKey, ["quoted"], { status: "quote_expired" });
      throw new RescueServiceError(409, "QUOTE_EXPIRED_REFRESH_REQUIRED");
    }
    if (!isAddress(quote.depositAddress, { strict: false })) throw new RescueServiceError(502, "INVALID_PROVIDER_DEPOSIT_ADDRESS");
    if (!/^[0-9]{1,78}$/.test(input.reimbursementAmountBaseUnits)) {
      throw new RescueServiceError(400, "INVALID_REIMBURSEMENT_AMOUNT");
    }
    const reimbursementAmountBaseUnits = BigInt(input.reimbursementAmountBaseUnits);
    const amountBaseUnits = BigInt(quote.requestedAmountBaseUnits);
    const totalAuthorizedAmount = amountBaseUnits + reimbursementAmountBaseUnits;
    if (amountBaseUnits <= 0n || reimbursementAmountBaseUnits <= 0n || totalAuthorizedAmount > BigInt(leg.balanceAtScanBaseUnits)) {
      throw new RescueServiceError(400, "AMOUNT_EXCEEDS_SCANNED_BALANCE");
    }
    const depositAddress = getAddress(quote.depositAddress);
    let routerSettings: ReturnType<typeof routerSettingsForChain>;
    try {
      routerSettings = routerSettingsForChain(chainKey);
    } catch {
      throw new RescueServiceError(503, "RESCUE_ROUTER_NOT_CONFIGURED");
    }
    if (reimbursementAmountBaseUnits > routerSettings.reimbursementCapBaseUnits) {
      throw new RescueServiceError(400, "REIMBURSEMENT_EXCEEDS_CONFIGURED_CAP", {
        maximumReimbursementBaseUnits: routerSettings.reimbursementCapBaseUnits.toString()
      });
    }
    let relayer: ReturnType<typeof getRelayerForChain>["account"];
    try {
      ({ account: relayer } = getRelayerForChain(chainKey));
    } catch {
      throw new RescueServiceError(503, "RELAYER_NOT_CONFIGURED");
    }
    const routerAddress = routerSettings.address;
    if ([job.sourceAddress, job.cleanRefundAddress, depositAddress].some((address) => address.toLowerCase() === routerAddress.toLowerCase()) ||
        [job.sourceAddress, job.cleanRefundAddress, depositAddress, routerAddress].some((address) => address.toLowerCase() === relayer.address.toLowerCase())) {
      throw new RescueServiceError(400, "DESTINATION_MUST_BE_DISTINCT");
    }

    const config = RESCUE_CHAINS[chainKey];
    const client = getPublicClient(chainKey);
    const [chainId, code, routerCode, routerUsdc, routerTtl, name, symbol, version, decimals, currentBalance, block] = await Promise.all([
      client.getChainId(),
      client.getCode({ address: config.usdc }),
      client.getCode({ address: routerAddress }),
      client.readContract({ address: routerAddress, abi: rescueRouterAbi, functionName: "usdc" }),
      client.readContract({ address: routerAddress, abi: rescueRouterAbi, functionName: "MAX_AUTHORIZATION_TTL" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "name" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "symbol" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "version" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "decimals" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "balanceOf", args: [job.sourceAddress] }),
      client.getBlock({ blockTag: "latest" })
    ]);
    if (chainId !== config.chain.id || !code || code === "0x" || !routerCode || routerCode === "0x" ||
        routerUsdc.toLowerCase() !== config.usdc.toLowerCase() || routerTtl !== AUTHORIZATION_TTL_SECONDS ||
        keccak256(routerCode).toLowerCase() !== routerSettings.codeHash.toLowerCase()) {
      throw new RescueServiceError(502, "CHAIN_TOKEN_OR_ROUTER_VALIDATION_FAILED");
    }
    if (name !== "USD Coin" || symbol !== "USDC" || version !== "2" || decimals !== 6) {
      throw new RescueServiceError(502, "NATIVE_USDC_METADATA_MISMATCH");
    }
    if (currentBalance < totalAuthorizedAmount) throw new RescueServiceError(409, "CURRENT_BALANCE_TOO_LOW");

    const nonce = `0x${cryptoRandomHex32()}` as Hex;
    const routeNonce = `0x${cryptoRandomHex32()}` as Hex;
    const [nonceUsed, routeNonceUsed] = await Promise.all([
      client.readContract({
        address: config.usdc,
        abi: nativeUsdcAbi,
        functionName: "authorizationState",
        args: [job.sourceAddress, nonce]
      }),
      client.readContract({
        address: routerAddress,
        abi: rescueRouterAbi,
        functionName: "routeNonceUsed",
        args: [job.sourceAddress, routeNonce]
      })
    ]);
    if (nonceUsed || routeNonceUsed) throw new RescueServiceError(503, "NONCE_COLLISION_RETRY");

    const prepared = makeTransferAuthorization({
      chainKey,
      tokenName: name,
      tokenVersion: version,
      from: job.sourceAddress,
      to: routerAddress,
      amountBaseUnits: totalAuthorizedAmount,
      chainTimestamp: block.timestamp,
      nonce
    });
    const rescueRoute: RescueRoute = {
      owner: job.sourceAddress,
      token: config.usdc,
      amount: totalAuthorizedAmount,
      depositAddress,
      relayer: relayer.address,
      reimbursementAmount: reimbursementAmountBaseUnits,
      validAfter: prepared.message.validAfter,
      validBefore: prepared.message.validBefore,
      transferNonce: nonce,
      routeNonce
    };
    const updated = await this.repository.updateLeg(jobId, chainKey, ["quoted"], {
      status: "awaiting_authorization",
      amountBaseUnits: totalAuthorizedAmount.toString(),
      destination: routerAddress,
      authorization: storeAuthorization(prepared.message),
      rescueRoute: storeRescueRoute(rescueRoute),
      preparedAtBlock: block.number?.toString() ?? "0",
      lastErrorCode: null
    });
    if (!updated) throw new RescueServiceError(409, "LEG_STATE_CHANGED");
    return {
      jobId,
      chain: { key: chainKey, chainId, token: config.usdc, tokenName: name, tokenVersion: version },
      // Express JSON cannot encode bigint. Decimal strings remain valid
      // EIP-712 uint256 values and avoid lossy number conversion in browsers.
      authorization: storeAuthorization(prepared.message),
      domain: prepared.domain,
      primaryType: prepared.primaryType,
      types: prepared.types,
      routeConsent: {
        domain: rescueRouteDomain(chainKey, routerAddress),
        primaryType: "RescueRoute",
        types: rescueRouteTypes,
        message: storeRescueRoute(rescueRoute)
      },
      reimbursement: {
        amountBaseUnits: reimbursementAmountBaseUnits.toString(),
        recipient: relayer.address,
        configuredCapBaseUnits: routerSettings.reimbursementCapBaseUnits.toString(),
        estimateDisclaimer: "This is the exact fixed USDC amount you authorize for the relayer, not a guaranteed conversion of actual gas cost."
      },
      depositAddress,
      routerAddress,
      totalAuthorizedAmountBaseUnits: totalAuthorizedAmount.toString(),
      victimPaysNativeGas: false,
      expiresInSeconds: Number(AUTHORIZATION_TTL_SECONDS),
      signaturesStored: false,
      quote: serializeIntentQuote(quote)
    };
  }

  async submitAuthorization(jobId: string, chainKey: ChainKey, input: SubmitAuthorizationInput): Promise<RescueJob> {
    const idempotencyHash = hashIdempotencyKey(input.idempotencyKey);
    const job = await this.getJob(jobId);
    const leg = getLeg(job, chainKey);

    if ((leg.status === "submitted" || leg.status === "source_confirmed") &&
        leg.idempotencyKeyHash?.toLowerCase() === idempotencyHash.toLowerCase()) return job;
    if (leg.status === "submitting") return this.reconcileUncertainSubmission(job, leg);
    if (leg.status !== "awaiting_authorization" || !leg.authorization || !leg.rescueRoute || !leg.amountBaseUnits || !leg.destination || !leg.intentQuote) {
      throw new RescueServiceError(409, "LEG_NOT_AWAITING_AUTHORIZATION");
    }
    if (quoteExpiry(leg.intentQuote).getTime() <= Date.now() + 15_000) {
      await this.repository.updateLeg(jobId, chainKey, ["awaiting_authorization"], {
        status: "quote_expired",
        authorization: null,
        rescueRoute: null,
        destination: null,
        amountBaseUnits: null,
        preparedAtBlock: null,
        estimatedRelayGasCostWei: null
      });
      throw new RescueServiceError(409, "QUOTE_EXPIRED_REFRESH_REQUIRED");
    }

    const authorization = restoreAuthorization(leg.authorization);
    const route = restoreRescueRoute(leg.rescueRoute);
    const prepared = preparedFromStored(chainKey, authorization);
    const config = RESCUE_CHAINS[chainKey];
    const routerAddress = leg.destination;
    let authorizationSigner: Address;
    let routeSigner: Address;
    try {
      [authorizationSigner, routeSigner] = await Promise.all([
        recoverAuthorizationSigner(prepared, input.signature),
        recoverRescueRouteSigner(chainKey, routerAddress, route, input.routeSignature)
      ]);
    } catch {
      throw new RescueServiceError(400, "INVALID_USER_SIGNATURE");
    }
    if (authorizationSigner.toLowerCase() !== job.sourceAddress.toLowerCase() || routeSigner.toLowerCase() !== job.sourceAddress.toLowerCase()) {
      throw new RescueServiceError(400, "SIGNER_DOES_NOT_MATCH_SOURCE_WALLET");
    }
    const providerAmount = BigInt(leg.intentQuote.requestedAmountBaseUnits);
    if (!authorizationMatches(authorization, {
      ...authorization,
      from: route.owner,
      value: route.amount,
      to: routerAddress,
      validAfter: route.validAfter,
      validBefore: route.validBefore,
      nonce: route.transferNonce
    }) || !rescueRouteMatches(route, {
      ...route,
      owner: job.sourceAddress,
      token: config.usdc,
      amount: BigInt(leg.amountBaseUnits),
      depositAddress: getAddress(leg.intentQuote.depositAddress),
      transferNonce: authorization.nonce
    }) || route.amount !== providerAmount + route.reimbursementAmount ||
        route.amount !== authorization.value || route.validAfter !== authorization.validAfter ||
        route.validBefore !== authorization.validBefore) {
      throw new RescueServiceError(400, "ROUTE_OR_AUTHORIZATION_BINDING_MISMATCH");
    }

    const publicClient = getPublicClient(chainKey);
    let routerSettings: ReturnType<typeof routerSettingsForChain>;
    try {
      routerSettings = routerSettingsForChain(chainKey);
    } catch {
      throw new RescueServiceError(503, "RESCUE_ROUTER_NOT_CONFIGURED");
    }
    if (routerSettings.address.toLowerCase() !== routerAddress.toLowerCase() ||
        route.reimbursementAmount > routerSettings.reimbursementCapBaseUnits) {
      throw new RescueServiceError(409, "RESCUE_ROUTER_CONFIGURATION_CHANGED");
    }
    let relayer: ReturnType<typeof getRelayerForChain>["account"];
    let walletClient: ReturnType<typeof getRelayerForChain>["client"];
    try {
      ({ account: relayer, client: walletClient } = getRelayerForChain(chainKey));
    } catch {
      throw new RescueServiceError(503, "RELAYER_NOT_CONFIGURED");
    }
    if (relayer.address.toLowerCase() !== route.relayer.toLowerCase()) {
      throw new RescueServiceError(409, "RELAYER_CONFIGURATION_CHANGED");
    }
    const [chainId, block, nonceUsed, routeNonceUsed, currentBalance, routerCode, routerUsdc, routerTtl] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock({ blockTag: "latest" }),
      publicClient.readContract({
        address: config.usdc,
        abi: nativeUsdcAbi,
        functionName: "authorizationState",
        args: [job.sourceAddress, authorization.nonce]
      }),
      publicClient.readContract({
        address: routerAddress,
        abi: rescueRouterAbi,
        functionName: "routeNonceUsed",
        args: [job.sourceAddress, route.routeNonce]
      }),
      publicClient.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "balanceOf", args: [job.sourceAddress] }),
      publicClient.getCode({ address: routerAddress }),
      publicClient.readContract({ address: routerAddress, abi: rescueRouterAbi, functionName: "usdc" }),
      publicClient.readContract({ address: routerAddress, abi: rescueRouterAbi, functionName: "MAX_AUTHORIZATION_TTL" })
    ]);
    if (chainId !== config.chain.id) throw new RescueServiceError(502, "RPC_CHAIN_ID_MISMATCH");
    if (!routerCode || routerCode === "0x" || routerUsdc.toLowerCase() !== config.usdc.toLowerCase() ||
        routerTtl !== AUTHORIZATION_TTL_SECONDS || keccak256(routerCode).toLowerCase() !== routerSettings.codeHash.toLowerCase()) {
      throw new RescueServiceError(502, "ROUTER_CODE_OR_TOKEN_MISMATCH");
    }
    assertAuthorizationWindow(authorization, block.timestamp);
    if (nonceUsed || routeNonceUsed) throw new RescueServiceError(409, "AUTHORIZATION_OR_ROUTE_NONCE_ALREADY_USED");
    if (currentBalance < authorization.value) throw new RescueServiceError(409, "CURRENT_BALANCE_TOO_LOW");

    if ([job.sourceAddress, authorization.to, job.cleanRefundAddress].some((address) => address.toLowerCase() === relayer.address.toLowerCase())) {
      throw new RescueServiceError(400, "RELAYER_MUST_BE_DISTINCT");
    }
    const transferSignature = signatureParts(input.signature);
    const routeSignature = signatureParts(input.routeSignature);
    const args = [
      route,
      transferSignature.v,
      transferSignature.r,
      transferSignature.s,
      routeSignature.v,
      routeSignature.r,
      routeSignature.s
    ] as const;
    const simulation = await publicClient.simulateContract({
      account: relayer,
      address: routerAddress,
      abi: rescueRouterAbi,
      functionName: "execute",
      args
    });
    const simulationData = encodeFunctionData({
      abi: rescueRouterAbi,
      functionName: "execute",
      args
    });
    if (!simulation.request || simulationData.length < 10) throw new RescueServiceError(409, "SIMULATION_FAILED");
    const [estimatedGas, fees, nativeBalance] = await Promise.all([
      publicClient.estimateGas({ account: relayer.address, to: routerAddress, data: simulationData }),
      publicClient.estimateFeesPerGas(),
      publicClient.getBalance({ address: relayer.address })
    ]);
    const maximumFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
    if (maximumFeePerGas === undefined) throw new RescueServiceError(503, "RELAY_GAS_PRICE_UNAVAILABLE");
    const gasLimit = (estimatedGas * 120n + 99n) / 100n;
    let rollupExtraFeesWei = 0n;
    if (chainKey === "base") {
      const feeParams = {
        account: relayer.address,
        to: routerAddress,
        data: simulationData,
        gas: gasLimit,
        maxFeePerGas: maximumFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? maximumFeePerGas
      };
      try {
        const [l1DataFee, operatorFee] = await Promise.all([
          estimateL1Fee(publicClient, feeParams),
          estimateOperatorFee(publicClient, feeParams)
        ]);
        // Leave 20% headroom for fee-oracle movement between estimate and inclusion.
        rollupExtraFeesWei = ((l1DataFee + operatorFee) * 120n + 99n) / 100n;
      } catch {
        throw new RescueServiceError(503, "BASE_ROLLUP_FEE_ESTIMATE_UNAVAILABLE");
      }
    }
    const estimatedGasCostWei = gasLimit * maximumFeePerGas + rollupExtraFeesWei;
    if (estimatedGasCostWei > routerSettings.maxRelayGasCostWei) {
      throw new RescueServiceError(422, "RELAY_GAS_COST_EXCEEDS_CONFIGURED_CAP", {
        estimatedGasCostWei: estimatedGasCostWei.toString(),
        maximumGasCostWei: routerSettings.maxRelayGasCostWei.toString()
      });
    }
    // Keep enough native balance for one failed attempt plus the measured estimate.
    if (nativeBalance < estimatedGasCostWei * 2n) throw new RescueServiceError(409, "RELAYER_NATIVE_BALANCE_TOO_LOW");

    const lockedJob = await this.repository.updateLeg(jobId, chainKey, ["awaiting_authorization"], {
      status: "submitting",
      idempotencyKeyHash: idempotencyHash,
      estimatedRelayGasCostWei: estimatedGasCostWei.toString()
    });
    if (!lockedJob) throw new RescueServiceError(409, "SUBMISSION_ALREADY_CLAIMED");

    try {
      const transactionHash = await walletClient.writeContract({
        ...simulation.request,
        gas: gasLimit
      });
      const submitted = await this.repository.updateLeg(jobId, chainKey, ["submitting"], {
        status: "submitted",
        transactionHash
      });
      if (!submitted) throw new Error("SUBMISSION_STATE_PERSISTENCE_FAILED");
      return submitted;
    } catch {
      const uncertain = await this.repository.updateLeg(jobId, chainKey, ["submitting"], {
        status: "needs_review",
        lastErrorCode: "SUBMISSION_RESULT_UNCERTAIN"
      });
      if (uncertain) return uncertain;
      throw new RescueServiceError(503, "SUBMISSION_RESULT_UNCERTAIN");
    }
  }

  async refreshJob(jobId: string): Promise<RescueJob> {
    let job = await this.getJob(jobId);
    for (const leg of job.legs) {
      let currentLeg = getLeg(job, leg.chainKey);
      if (currentLeg.status === "awaiting_authorization") {
        job = await this.refreshPreparedAuthorization(job, currentLeg);
        currentLeg = getLeg(job, leg.chainKey);
      }
      if (currentLeg.status === "submitted" && currentLeg.transactionHash) {
        job = await this.refreshSubmittedLeg(job, currentLeg);
      } else if (currentLeg.status === "submitting" ||
          (currentLeg.status === "needs_review" && ["SUBMISSION_RESULT_UNCERTAIN", "SUBMISSION_UNKNOWN_NONCE_UNUSED"].includes(currentLeg.lastErrorCode ?? ""))) {
        job = await this.reconcileUncertainSubmission(job, currentLeg);
      }
      currentLeg = getLeg(job, leg.chainKey);
      job = await this.refreshIntentLeg(job, currentLeg);
    }
    return job;
  }

  private async refreshPreparedAuthorization(job: RescueJob, leg: RescueLeg): Promise<RescueJob> {
    if (!leg.authorization || !leg.rescueRoute || !leg.intentQuote) return job;
    if (quoteExpiry(leg.intentQuote).getTime() <= Date.now() + 15_000) {
      return await this.repository.updateLeg(job.jobId, leg.chainKey, ["awaiting_authorization"], {
        status: "quote_expired",
        authorization: null,
        rescueRoute: null,
        destination: null,
        amountBaseUnits: null,
        preparedAtBlock: null,
        estimatedRelayGasCostWei: null
      }) ?? job;
    }
    try {
      const block = await getPublicClient(leg.chainKey).getBlock({ blockTag: "latest" });
      const authorization = restoreAuthorization(leg.authorization);
      if (authorization.validBefore > block.timestamp + 15n) return job;
      return await this.repository.updateLeg(job.jobId, leg.chainKey, ["awaiting_authorization"], {
        status: "quoted",
        authorization: null,
        rescueRoute: null,
        destination: getAddress(leg.intentQuote.depositAddress),
        amountBaseUnits: leg.intentQuote.requestedAmountBaseUnits,
        preparedAtBlock: null,
        estimatedRelayGasCostWei: null
      }) ?? job;
    } catch {
      return job;
    }
  }

  private async refreshIntentLeg(job: RescueJob, leg: RescueLeg): Promise<RescueJob> {
    if (leg.status === "quoted" && leg.intentQuote && quoteExpiry(leg.intentQuote).getTime() <= Date.now()) {
      return await this.repository.updateLeg(job.jobId, leg.chainKey, ["quoted"], { status: "quote_expired" }) ?? job;
    }
    if (!leg.intentQuote || (leg.status !== "source_confirmed" && leg.status !== "converting" && leg.status !== "under_review")) {
      return job;
    }
    const quote = leg.intentQuote;
    if (leg.status === "source_confirmed") {
      const started = await this.repository.updateLeg(job.jobId, leg.chainKey, ["source_confirmed"], {
        status: "converting",
        lastErrorCode: null
      });
      if (!started) return job;
      job = started;
      leg = getLeg(job, leg.chainKey);
    }

    try {
      const status = await this.nearIntents.getStatus(quote.depositAddress, quote.depositMemo);
      const signedQuote = status.quoteResponse;
      if (signedQuote.correlationId !== quote.correlationId ||
          signedQuote.quote.depositAddress.toLowerCase() !== quote.depositAddress.toLowerCase()) {
        return await this.repository.updateLeg(job.jobId, leg.chainKey, [leg.status], {
          status: "needs_review",
          lastErrorCode: "PROVIDER_STATUS_QUOTE_MISMATCH"
        }) ?? job;
      }

      const providerStatus = status.status.toUpperCase();
      let targetStatus: LegStatus | undefined;
      if (providerStatus === "UNDER_REVIEW") targetStatus = "under_review";
      else if (providerStatus === "REFUNDED") targetStatus = "refunded";
      else if (providerStatus === "FAILED") targetStatus = "failed";
      else if (["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS"].includes(providerStatus)) {
        targetStatus = "converting";
      } else {
        targetStatus = "needs_review";
      }
      const patch = {
        ...(targetStatus !== leg.status ? { status: targetStatus } : {}),
        providerStatus,
        lastErrorCode: targetStatus === "needs_review" ? "UNRECOGNIZED_PROVIDER_STATUS" : null
      };
      return await this.repository.updateLeg(job.jobId, leg.chainKey, [leg.status], patch) ?? job;
    } catch (error) {
      const code = error instanceof NearIntentsError ? error.code : "NEAR_INTENTS_STATUS_UNAVAILABLE";
      if (code === "INVALID_PROVIDER_SIGNATURE" || code === "INVALID_PROVIDER_RESPONSE") {
        return await this.repository.updateLeg(job.jobId, leg.chainKey, [leg.status], {
          status: "needs_review",
          lastErrorCode: code
        }) ?? job;
      }
      return await this.repository.updateLeg(job.jobId, leg.chainKey, [leg.status], {
        lastErrorCode: code
      }) ?? job;
    }
  }

  private async refreshSubmittedLeg(job: RescueJob, leg: RescueLeg): Promise<RescueJob> {
    const client = getPublicClient(leg.chainKey);
    try {
      const receipt = await client.getTransactionReceipt({ hash: leg.transactionHash as Hex });
      const status: LegStatus = receipt.status === "success" ? "source_confirmed" : "failed";
      if (!canTransitionLeg(leg.status, status)) return job;
      const l1DataFee = "l1Fee" in receipt && typeof receipt.l1Fee === "bigint" ? receipt.l1Fee : undefined;
      const executionGasCost = receipt.effectiveGasPrice === undefined || (leg.chainKey === "base" && l1DataFee === undefined)
        ? undefined
        : (receipt.gasUsed * receipt.effectiveGasPrice + (l1DataFee ?? 0n)).toString();
      const updated = await this.repository.updateLeg(job.jobId, leg.chainKey, ["submitted"], {
        status,
        ...(executionGasCost ? { receiptGasCostWei: executionGasCost } : {}),
        lastErrorCode: receipt.status === "success" ? null : "SOURCE_TRANSACTION_REVERTED"
      });
      return updated ?? job;
    } catch {
      return job;
    }
  }

  private async reconcileUncertainSubmission(job: RescueJob, leg: RescueLeg): Promise<RescueJob> {
    const config = RESCUE_CHAINS[leg.chainKey];
    const client = getPublicClient(leg.chainKey);
    const auth = leg.authorization ? restoreAuthorization(leg.authorization) : undefined;
    if (!auth) return job;
    try {
      const [used, latest] = await Promise.all([
        client.readContract({
          address: config.usdc,
          abi: nativeUsdcAbi,
          functionName: "authorizationState",
          args: [auth.from, auth.nonce]
        }),
        client.getBlock({ blockTag: "latest" })
      ]);
      if (!used) {
        const updated = await this.repository.updateLeg(job.jobId, leg.chainKey, ["submitting", "needs_review"], {
          status: "needs_review",
          lastErrorCode: "SUBMISSION_UNKNOWN_NONCE_UNUSED"
        });
        return updated ?? job;
      }
      const fromBlock = BigInt(leg.preparedAtBlock ?? "0");
      const toBlock = latest.number ?? fromBlock;
      if (toBlock - fromBlock > 5_000n) {
        const updated = await this.repository.updateLeg(job.jobId, leg.chainKey, ["submitting", "needs_review"], {
          status: "needs_review",
          lastErrorCode: "USED_NONCE_EVENT_OUTSIDE_RECOVERY_WINDOW"
        });
        return updated ?? job;
      }
      const eventAbi = [nativeUsdcAbi[7]] as const;
      const logs = await client.getLogs({
        address: config.usdc,
        event: eventAbi[0],
        args: { authorizer: auth.from, nonce: auth.nonce },
        fromBlock,
        toBlock
      });
      const eventLog = logs.at(-1);
      if (!eventLog?.transactionHash) {
        const updated = await this.repository.updateLeg(job.jobId, leg.chainKey, ["submitting", "needs_review"], {
          status: "needs_review",
          lastErrorCode: "USED_NONCE_TRANSACTION_NOT_FOUND"
        });
        return updated ?? job;
      }
      const submitted = await this.repository.updateLeg(job.jobId, leg.chainKey, ["submitting", "needs_review"], {
        status: "submitted",
        transactionHash: eventLog.transactionHash
      });
      if (!submitted) return job;
      const recoveredLeg = getLeg(submitted, leg.chainKey);
      return this.refreshSubmittedLeg(submitted, recoveredLeg);
    } catch {
      return job;
    }
  }
}

function cryptoRandomHex32(): string {
  return randomBytes(32).toString("hex");
}

function exactUsdcAsset(tokens: NearToken[], chainKey: ChainKey, contractAddress: Address): NearToken {
  const blockchain = chainKey === "base" ? "base" : "arb";
  const matches = tokens.filter((token) => token.blockchain === blockchain &&
    token.symbol.toUpperCase() === "USDC" && token.decimals === 6 &&
    token.contractAddress?.toLowerCase() === contractAddress.toLowerCase());
  if (matches.length !== 1) throw new RescueServiceError(409, "NATIVE_USDC_ROUTE_UNAVAILABLE");
  return matches[0]!;
}

function exactZecAsset(tokens: NearToken[]): NearToken {
  const matches = tokens.filter((token) => token.blockchain === "zec" && token.symbol.toUpperCase() === "ZEC");
  if (matches.length !== 1) throw new RescueServiceError(409, "TRANSPARENT_ZEC_ROUTE_UNAVAILABLE");
  return matches[0]!;
}

function validateSignedQuote(
  quote: SignedNearQuote,
  expected: { originAsset: string; destinationAsset: string; amount: string; refundTo: Address; recipient: string }
): void {
  const request = quote.quoteRequest;
  if (request.dry !== false || request.swapType !== "EXACT_INPUT" || request.slippageTolerance !== 100 ||
      request.depositType !== "ORIGIN_CHAIN" || request.refundType !== "ORIGIN_CHAIN" ||
      request.recipientType !== "DESTINATION_CHAIN" ||
      request.originAsset !== expected.originAsset || request.destinationAsset !== expected.destinationAsset ||
      request.amount !== expected.amount || request.refundTo.toLowerCase() !== expected.refundTo.toLowerCase() ||
      request.recipient !== expected.recipient) {
    throw new RescueServiceError(502, "PROVIDER_QUOTE_BINDING_MISMATCH");
  }
}

function validDate(value: string): Date {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RescueServiceError(502, "INVALID_PROVIDER_EXPIRY");
  return new Date(milliseconds);
}

function quoteExpiry(quote: IntentQuoteSnapshot): Date {
  return quote.timeWhenInactive ?? quote.deadline;
}

function serializeIntentQuote(quote: IntentQuoteSnapshot) {
  return {
    ...quote,
    deadline: quote.deadline.toISOString(),
    ...(quote.timeWhenInactive ? { timeWhenInactive: quote.timeWhenInactive.toISOString() } : {}),
    expiresAt: quoteExpiry(quote).toISOString()
  };
}

export function serializeRescueJob(job: RescueJob) {
  return {
    jobId: job.jobId,
    sourceAddress: job.sourceAddress,
    cleanRefundAddress: job.cleanRefundAddress,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    revision: job.revision,
    workflow: summarizeWorkflow(job),
    legs: job.legs.map((leg) => ({
      chainKey: leg.chainKey,
      chainId: leg.chainId,
      tokenAddress: leg.tokenAddress,
      balanceAtScanBaseUnits: leg.balanceAtScanBaseUnits,
      status: leg.status,
      amountBaseUnits: leg.amountBaseUnits,
      destination: leg.destination,
      intentQuote: leg.intentQuote ? serializeIntentQuote(leg.intentQuote) : undefined,
      providerStatus: leg.providerStatus,
      authorization: leg.authorization,
      reimbursementAmountBaseUnits: leg.rescueRoute?.reimbursementAmount,
      estimatedRelayGasCostWei: leg.estimatedRelayGasCostWei,
      transactionHash: leg.transactionHash,
      receiptGasCostWei: leg.receiptGasCostWei,
      errorCode: leg.lastErrorCode
    }))
  };
}

export function validateSelectedChain(value: unknown): value is ChainKey {
  return value === "base" || value === "arbitrum";
}
