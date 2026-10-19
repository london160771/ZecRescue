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
import { getRelayerForChain } from "../config/relayer.js";
import {
  AUTHORIZATION_TTL_SECONDS,
  getPublicClient,
  RESCUE_CHAINS,
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
  canTransitionLeg,
  type LegStatus,
  type RescueJob,
  type RescueLeg
} from "../domain/jobs.js";
import { nativeUsdcAbi } from "../evm/native-usdc-abi.js";
import type { RescueJobRepository } from "../repositories/rescue-job-repository.js";
import { parseSourceAddress, scanChainBalance, scanNativeUsdc } from "./balance-scanner.js";

export class RescueServiceError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
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

export type PrepareAuthorizationInput = {
  amountBaseUnits: string;
  destination: string;
};

export type SubmitAuthorizationInput = {
  signature: Hex;
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
  constructor(private readonly repository: RescueJobRepository) {}

  async scan(sourceAddress: string) {
    if (!isAddress(sourceAddress, { strict: false })) throw new RescueServiceError(400, "INVALID_SOURCE_ADDRESS");
    return scanNativeUsdc(sourceAddress, V1_CHAIN_KEYS);
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

  async getJob(jobId: string): Promise<RescueJob> {
    const job = await this.repository.get(jobId);
    if (!job) throw new RescueServiceError(404, "RESCUE_JOB_NOT_FOUND");
    return job;
  }

  async prepareAuthorization(jobId: string, chainKey: ChainKey, input: PrepareAuthorizationInput) {
    const job = await this.getJob(jobId);
    const leg = getLeg(job, chainKey);
    if (leg.status !== "discovered") throw new RescueServiceError(409, "LEG_NOT_PREPARABLE");
    if (!/^\d{1,78}$/.test(input.amountBaseUnits)) throw new RescueServiceError(400, "INVALID_AMOUNT_BASE_UNITS");
    const amountBaseUnits = BigInt(input.amountBaseUnits);
    if (amountBaseUnits <= 0n || amountBaseUnits > BigInt(leg.balanceAtScanBaseUnits)) {
      throw new RescueServiceError(400, "AMOUNT_EXCEEDS_SCANNED_BALANCE");
    }
    if (!isAddress(input.destination, { strict: false })) throw new RescueServiceError(400, "INVALID_DESTINATION");
    const destination = getAddress(input.destination);
    if (destination.toLowerCase() === job.sourceAddress.toLowerCase() ||
        destination.toLowerCase() === job.cleanRefundAddress.toLowerCase()) {
      throw new RescueServiceError(400, "DESTINATION_MUST_BE_DISTINCT");
    }

    const config = RESCUE_CHAINS[chainKey];
    const client = getPublicClient(chainKey);
    const [chainId, code, name, symbol, version, decimals, currentBalance, block] = await Promise.all([
      client.getChainId(),
      client.getCode({ address: config.usdc }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "name" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "symbol" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "version" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "decimals" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "balanceOf", args: [job.sourceAddress] }),
      client.getBlock({ blockTag: "latest" })
    ]);
    if (chainId !== config.chain.id || !code || code === "0x") throw new RescueServiceError(502, "CHAIN_OR_TOKEN_VALIDATION_FAILED");
    if (name !== "USD Coin" || symbol !== "USDC" || version !== "2" || decimals !== 6) {
      throw new RescueServiceError(502, "NATIVE_USDC_METADATA_MISMATCH");
    }
    if (currentBalance < amountBaseUnits) throw new RescueServiceError(409, "CURRENT_BALANCE_TOO_LOW");

    const nonce = `0x${cryptoRandomHex32()}` as Hex;
    const nonceUsed = await client.readContract({
      address: config.usdc,
      abi: nativeUsdcAbi,
      functionName: "authorizationState",
      args: [job.sourceAddress, nonce]
    });
    if (nonceUsed) throw new RescueServiceError(503, "NONCE_COLLISION_RETRY");

    const prepared = makeTransferAuthorization({
      chainKey,
      tokenName: name,
      tokenVersion: version,
      from: job.sourceAddress,
      to: destination,
      amountBaseUnits,
      chainTimestamp: block.timestamp,
      nonce
    });
    const updated = await this.repository.updateLeg(jobId, chainKey, ["discovered"], {
      status: "awaiting_authorization",
      amountBaseUnits: amountBaseUnits.toString(),
      destination,
      authorization: storeAuthorization(prepared.message),
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
      victimPaysNativeGas: false,
      expiresInSeconds: Number(AUTHORIZATION_TTL_SECONDS),
      signatureStored: false
    };
  }

  async submitAuthorization(jobId: string, chainKey: ChainKey, input: SubmitAuthorizationInput): Promise<RescueJob> {
    const idempotencyHash = hashIdempotencyKey(input.idempotencyKey);
    const job = await this.getJob(jobId);
    const leg = getLeg(job, chainKey);

    if ((leg.status === "submitted" || leg.status === "source_confirmed") &&
        leg.idempotencyKeyHash?.toLowerCase() === idempotencyHash.toLowerCase()) return job;
    if (leg.status === "submitting") return this.reconcileUncertainSubmission(job, leg);
    if (leg.status !== "awaiting_authorization" || !leg.authorization || !leg.amountBaseUnits || !leg.destination) {
      throw new RescueServiceError(409, "LEG_NOT_AWAITING_AUTHORIZATION");
    }

    const authorization = restoreAuthorization(leg.authorization);
    const prepared = preparedFromStored(chainKey, authorization);
    const signer = await recoverAuthorizationSigner(prepared, input.signature);
    if (signer.toLowerCase() !== job.sourceAddress.toLowerCase()) {
      throw new RescueServiceError(400, "SIGNER_DOES_NOT_MATCH_SOURCE_WALLET");
    }
    if (!authorizationMatches(authorization, {
      ...authorization,
      value: BigInt(leg.amountBaseUnits),
      to: leg.destination
    })) throw new RescueServiceError(400, "AUTHORIZATION_DOES_NOT_MATCH_PREPARED_LEG");

    const config = RESCUE_CHAINS[chainKey];
    const publicClient = getPublicClient(chainKey);
    const [chainId, block, nonceUsed, currentBalance] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock({ blockTag: "latest" }),
      publicClient.readContract({
        address: config.usdc,
        abi: nativeUsdcAbi,
        functionName: "authorizationState",
        args: [job.sourceAddress, authorization.nonce]
      }),
      publicClient.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "balanceOf", args: [job.sourceAddress] })
    ]);
    if (chainId !== config.chain.id) throw new RescueServiceError(502, "RPC_CHAIN_ID_MISMATCH");
    assertAuthorizationWindow(authorization, block.timestamp);
    if (nonceUsed) throw new RescueServiceError(409, "AUTHORIZATION_NONCE_ALREADY_USED");
    if (currentBalance < authorization.value) throw new RescueServiceError(409, "CURRENT_BALANCE_TOO_LOW");

    const { account: relayer, client: walletClient } = getRelayerForChain(chainKey);
    if ([job.sourceAddress, authorization.to, job.cleanRefundAddress].some((address) => address.toLowerCase() === relayer.address.toLowerCase())) {
      throw new RescueServiceError(400, "RELAYER_MUST_BE_DISTINCT");
    }
    const { v, r, s } = signatureParts(input.signature);
    const args = [
      authorization.from,
      authorization.to,
      authorization.value,
      authorization.validAfter,
      authorization.validBefore,
      authorization.nonce,
      v,
      r,
      s
    ] as const;
    const simulation = await publicClient.simulateContract({
      account: relayer,
      address: config.usdc,
      abi: nativeUsdcAbi,
      functionName: "transferWithAuthorization",
      args
    });
    const simulationData = encodeFunctionData({
      abi: nativeUsdcAbi,
      functionName: "transferWithAuthorization",
      args
    });
    if (!simulation.request || simulationData.length < 10) throw new RescueServiceError(409, "SIMULATION_FAILED");

    const lockedJob = await this.repository.updateLeg(jobId, chainKey, ["awaiting_authorization"], {
      status: "submitting",
      idempotencyKeyHash: idempotencyHash
    });
    if (!lockedJob) throw new RescueServiceError(409, "SUBMISSION_ALREADY_CLAIMED");

    try {
      const transactionHash = await walletClient.writeContract(simulation.request);
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
      if (leg.status === "submitted" && leg.transactionHash) {
        job = await this.refreshSubmittedLeg(job, leg);
      } else if (leg.status === "submitting" ||
          (leg.status === "needs_review" && ["SUBMISSION_RESULT_UNCERTAIN", "SUBMISSION_UNKNOWN_NONCE_UNUSED"].includes(leg.lastErrorCode ?? ""))) {
        job = await this.reconcileUncertainSubmission(job, leg);
      }
    }
    return job;
  }

  private async refreshSubmittedLeg(job: RescueJob, leg: RescueLeg): Promise<RescueJob> {
    const client = getPublicClient(leg.chainKey);
    try {
      const receipt = await client.getTransactionReceipt({ hash: leg.transactionHash as Hex });
      const status: LegStatus = receipt.status === "success" ? "source_confirmed" : "failed";
      if (!canTransitionLeg(leg.status, status)) return job;
      const executionGasCost = receipt.effectiveGasPrice === undefined
        ? undefined
        : (receipt.gasUsed * receipt.effectiveGasPrice).toString();
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

export function serializeRescueJob(job: RescueJob) {
  return {
    jobId: job.jobId,
    sourceAddress: job.sourceAddress,
    cleanRefundAddress: job.cleanRefundAddress,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    revision: job.revision,
    legs: job.legs.map((leg) => ({
      chainKey: leg.chainKey,
      chainId: leg.chainId,
      tokenAddress: leg.tokenAddress,
      balanceAtScanBaseUnits: leg.balanceAtScanBaseUnits,
      status: leg.status,
      amountBaseUnits: leg.amountBaseUnits,
      destination: leg.destination,
      authorization: leg.authorization,
      transactionHash: leg.transactionHash,
      receiptGasCostWei: leg.receiptGasCostWei,
      errorCode: leg.lastErrorCode
    }))
  };
}

export function validateSelectedChain(value: unknown): value is ChainKey {
  return value === "base" || value === "arbitrum";
}
