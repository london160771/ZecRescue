import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentError } from "../src/errors.js";
import {
  assertShieldProposalIsSourceScoped,
  sourceScopedShieldRequest,
  type ReceivePath,
  type ShieldProposalEvidence
} from "../src/wallet-provider.js";

function syntheticT1(fill: number): string {
  const payload = Buffer.concat([Buffer.from([0x1c, 0xb8]), Buffer.alloc(20, fill)]);
  const first = createHash("sha256").update(payload).digest();
  const checksum = createHash("sha256").update(first).digest().subarray(0, 4);
  const bytes = Buffer.concat([payload, checksum]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    encoded = `${alphabet[Number(value % 58n)]}${encoded}`;
    value /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return `${"1".repeat(zeros)}${encoded}`;
}

function path(sourceChain: ReceivePath["sourceChain"], address: string, pathId: string): ReceivePath {
  return {
    pathId,
    sourceChain,
    address,
    accountId: 0,
    receiverType: "transparent_p2pkh",
    generatedAt: new Date(0).toISOString()
  };
}

const basePath = path("base", syntheticT1(7), "839138ae-3d5b-4e8f-b811-8f66f2fb3191");
const arbitrumPath = path("arbitrum", syntheticT1(8), "c0a11b1e-78dd-47e9-b3c8-1d1189d29e42");

function evidenceFor(source: ReceivePath): ShieldProposalEvidence {
  return {
    pathId: source.pathId,
    sourceChain: source.sourceChain,
    sourceAccountId: 0,
    destinationAccountId: 0,
    sourceAddress: source.address,
    shieldedPool: "ironwood",
    selectedInputAddresses: [source.address]
  };
}

function expectSourceMismatch(operation: () => void): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentError);
  expect(caught).toMatchObject({ code: "SHIELD_PROPOSAL_SOURCE_MISMATCH" });
}

describe("source-isolated shielding contract", () => {
  it("builds distinct one-address allowlists for Base and Arbitrum", () => {
    const base = sourceScopedShieldRequest(basePath);
    const arbitrum = sourceScopedShieldRequest(arbitrumPath);

    expect(base.fromAddresses).toEqual([basePath.address]);
    expect(arbitrum.fromAddresses).toEqual([arbitrumPath.address]);
    expect(base.fromAddresses).not.toEqual(arbitrum.fromAddresses);
    expect(base).toMatchObject({ sourceChain: "base", sourceAccountId: 0, destinationAccountId: 0, requiredOutputPoolForEvidence: "ironwood" });
    expect(arbitrum).toMatchObject({ sourceChain: "arbitrum", sourceAccountId: 0, destinationAccountId: 0, requiredOutputPoolForEvidence: "ironwood" });
  });

  it("accepts evidence only when every selected input is the requested receiver", () => {
    assertShieldProposalIsSourceScoped(sourceScopedShieldRequest(basePath), evidenceFor(basePath));
    assertShieldProposalIsSourceScoped(sourceScopedShieldRequest(arbitrumPath), evidenceFor(arbitrumPath));

    const mixedEvidence = { ...evidenceFor(basePath), selectedInputAddresses: [basePath.address, arbitrumPath.address] };
    expectSourceMismatch(() => assertShieldProposalIsSourceScoped(sourceScopedShieldRequest(basePath), mixedEvidence));
  });

  it("rejects an empty proposal, wrong account, wrong source, or non-Ironwood target", () => {
    const request = sourceScopedShieldRequest(basePath);
    const invalidEvidence: ShieldProposalEvidence[] = [
      { ...evidenceFor(basePath), selectedInputAddresses: [] },
      { ...evidenceFor(basePath), sourceAccountId: 1 },
      { ...evidenceFor(basePath), destinationAccountId: 1 },
      { ...evidenceFor(basePath), sourceChain: "arbitrum" },
      { ...evidenceFor(basePath), shieldedPool: "orchard" }
    ];

    for (const evidence of invalidEvidence) {
      expectSourceMismatch(() => assertShieldProposalIsSourceScoped(request, evidence));
    }
  });
});
