import { createHash } from "node:crypto";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function isMainnetTransparentP2pkhAddress(address: string): boolean {
  if (!/^t1[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  const decoded = decodeBase58(address);
  if (!decoded || decoded.length !== 26 || decoded[0] !== 0x1c || decoded[1] !== 0xb8) return false;
  const payload = decoded.subarray(0, 22);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return checksum.every((value, index) => value === decoded[22 + index]);
}

function decodeBase58(value: string): Uint8Array | null {
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const hex = number === 0n ? "" : number.toString(16).padStart(Math.ceil(number.toString(16).length / 2) * 2, "0");
  const decoded = hex ? Uint8Array.from(Buffer.from(hex, "hex")) : new Uint8Array();
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros += 1;
  const result = new Uint8Array(leadingZeros + decoded.length);
  result.set(decoded, leadingZeros);
  return result;
}

function sha256(value: Uint8Array): Uint8Array {
  return createHash("sha256").update(value).digest();
}
