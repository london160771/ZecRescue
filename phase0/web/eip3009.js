export function encodeTransferAuthorization(selector, authorization, signature) {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) throw new Error("Bad EIP-3009 selector");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Expected a 65-byte ECDSA signature");
  const r = signature.slice(2, 66);
  const s = signature.slice(66, 130);
  let v = Number.parseInt(signature.slice(130, 132), 16);
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) throw new Error("Signature recovery byte must be 27 or 28");
  const word = (hex) => hex.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const address = (value) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Bad EVM address");
    return word(value);
  };
  const uint = (value) => {
    const number = BigInt(value);
    if (number < 0n) throw new Error("Negative ABI integer");
    return number.toString(16).padStart(64, "0");
  };
  if (!/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)) throw new Error("Bad nonce");
  return `${selector}${address(authorization.from)}${address(authorization.to)}${uint(authorization.value)}${uint(authorization.validAfter)}${uint(authorization.validBefore)}${authorization.nonce.slice(2).toLowerCase()}${uint(v)}${word(r)}${word(s)}`;
}
