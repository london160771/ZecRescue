export type BrowserAuthorization = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
};
export function encodeTransferAuthorization(
  selector: `0x${string}`,
  authorization: BrowserAuthorization,
  signature: `0x${string}`
): `0x${string}`;
