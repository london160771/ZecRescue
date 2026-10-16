import { encodeTransferAuthorization } from "/eip3009.js";

const $ = (id) => document.getElementById(id);
const provider = window.ethereum;
const state = { config: null, victim: null, preflight: null, signature: null, calldata: null, txHash: null, relayerBefore: null, dryRun: false, formSnapshot: null };

function setStatus(message) { $("status").textContent = message; }
function show(id, value) { $(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function requireWallet() { if (!provider?.request) throw new Error("No injected EVM wallet was found. Use a local wallet extension with separate disposable accounts."); return provider; }
function chainConfig() { return state.config.chains.find((item) => item.key === $("chain").value); }
function asBigInt(value) { return BigInt(value); }
function formatNative(wei) { return `${(Number(BigInt(wei)) / 1e18).toFixed(8)} ETH`; }
function amountFields() { return { chainKey: $("chain").value, victim: state.victim, destination: $("destination").value.trim(), relayer: $("relayer").value.trim(), amount: $("amount").value.trim() }; }
function assertFormUnchanged() {
  if (!state.formSnapshot || JSON.stringify(amountFields()) !== state.formSnapshot) {
    throw new Error("Chain, addresses, or amount changed after preflight. Discard this authorization and prepare again.");
  }
}
function setButtons() {
  $("sign").disabled = !state.preflight || state.dryRun || !state.preflight.broadcast.enabled;
  $("submit").disabled = !state.signature;
  $("replay").disabled = !state.txHash;
}

async function api(path, body) {
  const response = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const result = await response.json();
  if (!response.ok && response.status !== 202) throw new Error(result.error ?? `Local runner returned HTTP ${response.status}`);
  return { status: response.status, result };
}

async function connectVictim() {
  const wallet = requireWallet();
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("Wallet did not return an account");
  state.victim = accounts[0];
  $("victim-connected").textContent = state.victim;
  $("victim-connected").style.color = "#a9d8bc";
}

async function checkConnectedChain(expected) {
  const actual = await requireWallet().request({ method: "eth_chainId" });
  if (typeof actual !== "string" || BigInt(actual) !== BigInt(expected)) {
    throw new Error(`Wallet is on chain ${actual}; switch it to mainnet chain ID ${expected}`);
  }
}

async function prepare(isDryRun) {
  if (!state.victim) await connectVictim();
  const chain = chainConfig();
  await checkConnectedChain(chain.chainId);
  const accounts = await requireWallet().request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== state.victim.toLowerCase()) {
    throw new Error("Select the victim account before preflight");
  }
  const fields = amountFields();
  const result = await api("/api/preflight", fields);
  state.preflight = result.result;
  state.signature = null;
  state.calldata = null;
  state.txHash = null;
  state.relayerBefore = null;
  state.dryRun = isDryRun;
  state.formSnapshot = JSON.stringify(fields);
  const p = state.preflight;
  show("authorization-view", {
    mode: isDryRun ? "DRY RUN — no signing or broadcasting is possible from this result" : "Ready for user signing — no signature requested yet",
    chain: `${p.chain.name} (${p.chain.chainId})`,
    token: `${p.token.name} ${p.token.symbol} ${p.token.address}`,
    amount: `${p.amount.display} USDC (${p.amount.baseUnits} base units)`,
    destination: p.authorization.to,
    victim: p.authorization.from,
    relayer: p.addresses.relayer,
    nonce: p.authorization.nonce,
    validAfter: `${p.authorization.validAfter} (Unix seconds)`,
    expiry: `${p.authorization.validBefore} (Unix seconds; ${p.authorization.lifetimeSeconds} seconds from sampled block)`,
    eip712Domain: p.domain,
    mainnetChecks: p.checks,
    broadcastGate: p.broadcast,
    eip3009Selector: p.functionSelector
  });
  setButtons();
  setStatus(isDryRun ? "Dry-run checks passed. No signature or transaction was requested." : "Preflight passed. Review every field, then explicitly request the victim signature.");
}

async function signAuthorization() {
  const p = state.preflight;
  if (!p || state.dryRun) throw new Error("Prepare a real authorization first; dry-run data cannot be signed");
  assertFormUnchanged();
  if (!p.broadcast.enabled) throw new Error(p.broadcast.reason);
  const wallet = requireWallet();
  await checkConnectedChain(p.chain.chainId);
  const accounts = await wallet.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== p.addresses.victim.toLowerCase()) {
    throw new Error("Select the victim account in the wallet before signing");
  }
  const payload = {
    domain: p.domain,
    types: p.typedData.types,
    primaryType: p.typedData.primaryType,
    message: p.typedData.message
  };
  const signature = await wallet.request({ method: "eth_signTypedData_v4", params: [p.addresses.victim, JSON.stringify(payload)] });
  if (typeof signature !== "string") throw new Error("Wallet did not return a signature");
  state.signature = signature;
  state.calldata = encodeTransferAuthorization(p.functionSelector, p.authorization, signature);
  setButtons();
  setStatus("Victim authorization signature is held in this page's memory only. Switch wallet account to the separate relayer EOA.");
  show("result", { signed: true, victim: p.addresses.victim, amount: p.amount.display, destination: p.addresses.destination, expiresAtUnix: p.authorization.validBefore, signatureSentToServer: false });
}

async function waitForReceipt(hash) {
  const wallet = requireWallet();
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const receipt = await wallet.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) return receipt;
    setStatus(`Waiting for mainnet receipt… (${attempt + 1}/120)`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Receipt wait timed out. Keep the transaction hash; the transfer may still mine.");
}

async function submitFromRelayer() {
  const p = state.preflight;
  if (!state.signature || !state.calldata || !p) throw new Error("Sign the authorization as the victim first");
  assertFormUnchanged();
  if (!p.broadcast.enabled) throw new Error(p.broadcast.reason);
  const wallet = requireWallet();
  await checkConnectedChain(p.chain.chainId);
  const accounts = await wallet.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== p.addresses.relayer.toLowerCase()) {
    throw new Error("Switch the wallet to the separate relayer account before continuing");
  }

  const request = { from: p.addresses.relayer, to: p.token.address, data: state.calldata };
  await wallet.request({ method: "eth_call", params: [request, "latest"] });
  const gasEstimateHex = await wallet.request({ method: "eth_estimateGas", params: [request] });
  const gasPriceHex = await wallet.request({ method: "eth_gasPrice" });
  const relayerBeforeHex = await wallet.request({ method: "eth_getBalance", params: [p.addresses.relayer, "latest"] });
  const victimBeforeHex = await wallet.request({ method: "eth_getBalance", params: [p.addresses.victim, "latest"] });
  const estimate = asBigInt(gasEstimateHex);
  const gasPrice = asBigInt(gasPriceHex);
  const cushionWei = estimate * gasPrice * 2n;
  const relayerBefore = asBigInt(relayerBeforeHex);
  if (relayerBefore < cushionWei) throw new Error(`Relayer has ${formatNative(relayerBefore)}; estimated 2x fee cushion is ${formatNative(cushionWei)}`);

  const approved = window.confirm([
    `Broadcast on ${p.chain.name} MAINNET?`,
    `Token: native USDC ${p.token.address}`,
    `Amount: ${p.amount.display} USDC`,
    `Destination: ${p.addresses.destination}`,
    `Victim authorization nonce: ${p.authorization.nonce}`,
    `Expires: ${p.authorization.validBefore} Unix seconds`,
    `Transaction sender (relayer): ${p.addresses.relayer}`,
    `Estimated gas: ${estimate.toString()} at ${gasPrice.toString()} wei/gas`,
    "The wallet will ask for a separate transaction confirmation."
  ].join("\n"));
  if (!approved) { setStatus("Broadcast cancelled before wallet transaction prompt."); return; }

  await checkConnectedChain(p.chain.chainId);
  const confirmedAccounts = await wallet.request({ method: "eth_accounts" });
  if (!Array.isArray(confirmedAccounts) || confirmedAccounts[0]?.toLowerCase() !== p.addresses.relayer.toLowerCase()) {
    throw new Error("Wallet account changed after confirmation; transaction was not sent");
  }

  state.relayerBefore = relayerBefore.toString();
  const hash = await wallet.request({ method: "eth_sendTransaction", params: [request] });
  if (typeof hash !== "string") throw new Error("Wallet did not return a transaction hash");
  state.txHash = hash;
  setButtons();
  show("result", { txHash: hash, from: p.addresses.relayer, to: p.token.address, relayerBalanceBeforeWei: state.relayerBefore, victimNativeBeforeWei: victimBeforeHex, broadcasted: true });
  setStatus("Transaction submitted by the relayer wallet. Waiting for receipt.");
  await waitForReceipt(hash);
  const verified = await api("/api/verify", {
    chainKey: p.chain.key,
    txHash: hash,
    victim: p.addresses.victim,
    destination: p.addresses.destination,
    relayer: p.addresses.relayer,
    nonce: p.authorization.nonce,
    amountBaseUnits: p.amount.baseUnits
  });
  if (verified.status === 202 || verified.result.pending) { setStatus("The RPC has not indexed the receipt yet. Click replay verification later or retry after a short wait."); return; }
  const post = verified.result;
  const victimNativeAfter = asBigInt(post.balancesAfter.victimNative);
  const victimNativeBefore = asBigInt(victimBeforeHex);
  const relayerNativeAfter = asBigInt(post.balancesAfter.relayerNative);
  const relayerSpend = relayerBefore - relayerNativeAfter;
  show("result", {
    ...post,
    relayerNativeSpentWei: relayerSpend.toString(),
    relayerNativeSpentEth: formatNative(relayerSpend),
    victimNativeDeltaWei: (victimNativeAfter - victimNativeBefore).toString(),
    victimPaidZeroNativeGas: victimNativeAfter === victimNativeBefore,
    authorizationNonceConsumed: post.authorizationUsed,
    signatureSentToServer: false,
    note: "Balance-delta attribution assumes no unrelated transactions or deposits changed either account during this run. L2 account delta includes chain-specific fees when reflected by the RPC."
  });
  if (!post.authorizationUsed) throw new Error("Receipt exists but the USDC contract did not mark the authorization nonce used");
  if (victimNativeAfter !== victimNativeBefore) setStatus("Receipt verified, but victim native balance changed during the measurement; inspect for concurrent activity before calling this a zero-gas proof.");
  else setStatus("Receipt verified. Victim native balance delta is zero; relayer balance delta and receipt gas are shown. Replay-check button is ready.");
  setButtons();
}

async function verifyReplayRejection() {
  if (!state.txHash || !state.calldata || !state.preflight) throw new Error("A successful authorization transaction is required first");
  assertFormUnchanged();
  const p = state.preflight;
  const wallet = requireWallet();
  await checkConnectedChain(p.chain.chainId);
  const accounts = await wallet.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== p.addresses.relayer.toLowerCase()) {
    throw new Error("Select the relayer account for the read-only replay simulation");
  }
  let replayRejected = false;
  try {
    await wallet.request({ method: "eth_call", params: [{ from: p.addresses.relayer, to: p.token.address, data: state.calldata }, "latest"] });
  } catch {
    replayRejected = true;
  }
  const verified = await api("/api/verify", {
    chainKey: p.chain.key,
    txHash: state.txHash,
    victim: p.addresses.victim,
    destination: p.addresses.destination,
    relayer: p.addresses.relayer,
    nonce: p.authorization.nonce,
    amountBaseUnits: p.amount.baseUnits
  });
  if (verified.result.pending) throw new Error("Mainnet receipt is not available to verify");
  const nonceConsumed = verified.result.authorizationUsed === true;
  const withinSignedWindow = BigInt(verified.result.latestBlockTimestamp) < BigInt(p.authorization.validBefore);
  const pass = replayRejected && nonceConsumed && withinSignedWindow;
  show("result", {
    replaySimulationRejected: replayRejected,
    sameAuthorizationNonceConsumed: nonceConsumed,
    replayStillInsideOriginalWindow: withinSignedWindow,
    replayProof: pass ? "PASS — exact same signed calldata reverts under read-only eth_call while the original authorization window is still open, and the nonce is marked used" : "FAIL — do not claim replay protection from this run",
    txHash: state.txHash,
    transactionBroadcastForReplay: false
  });
  setStatus(pass ? "Replay rejected in eth_call; no replay transaction was broadcast." : "Replay proof did not pass. No second transaction was sent.");
}

async function initialize() {
  const config = await api("/api/config");
  state.config = config.result;
  $("amount").value = state.config.defaultAmount;
  for (const chain of state.config.chains) {
    const option = document.createElement("option");
    option.value = chain.key;
    option.textContent = `${chain.name} — ${chain.broadcast.enabled ? "broadcast enabled" : "dry-run only"}`;
    option.disabled = false;
    $("chain").append(option);
  }
  $("chain").value = "base";
}

$("connect").addEventListener("click", () => connectVictim().catch((error) => setStatus(error.message)));
$("dry-run").addEventListener("click", () => prepare(true).catch((error) => setStatus(error.message)));
$("prepare").addEventListener("click", () => prepare(false).catch((error) => setStatus(error.message)));
$("sign").addEventListener("click", () => signAuthorization().catch((error) => setStatus(error.message)));
$("submit").addEventListener("click", () => submitFromRelayer().catch((error) => setStatus(error.message)));
$("replay").addEventListener("click", () => verifyReplayRejection().catch((error) => setStatus(error.message)));
$("chain").addEventListener("change", () => { state.preflight = null; state.signature = null; state.calldata = null; state.txHash = null; state.formSnapshot = null; setButtons(); });
provider?.on?.("chainChanged", () => { state.signature = null; state.calldata = null; state.txHash = null; setButtons(); setStatus("Wallet chain changed. Re-run preflight before continuing."); });
provider?.on?.("accountsChanged", (accounts) => {
  const current = Array.isArray(accounts) ? accounts[0] : null;
  if (current?.toLowerCase() !== state.preflight?.addresses.relayer.toLowerCase()) {
    if (current?.toLowerCase() !== state.preflight?.addresses.victim.toLowerCase()) {
      state.signature = null;
      state.calldata = null;
      setButtons();
      setStatus("Wallet account changed. Reconnect victim and prepare a fresh authorization if needed.");
    }
  }
});
initialize().catch((error) => setStatus(`Could not load runner config: ${error.message}`));
