import { encodeTransferAuthorization } from "/eip3009.js";

const $ = (id) => document.getElementById(id);
const provider = window.ethereum;
const state = { config: null, victim: null, activeAccount: null, walletChainId: null, preflight: null, signature: null, calldata: null, txHash: null, submissionCheck: null, verifyRequest: null, transferProof: null, dryRun: false, formSnapshot: null };

function setStatus(message) { $("status").textContent = message; }
function show(id, value) { $(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function requireWallet() { if (!provider?.request) throw new Error("No injected EVM wallet was found. Use a local wallet extension with separate disposable accounts."); return provider; }
function asBigInt(value) { return BigInt(value); }
function formatNative(wei) { return `${(Number(BigInt(wei)) / 1e18).toFixed(8)} ETH`; }
function amountFields() { return { chainKey: $("chain").value, victim: state.victim, destination: $("destination").value.trim(), relayer: $("relayer").value.trim(), amount: $("amount").value.trim() }; }
function assertFormUnchanged() {
  if (!state.formSnapshot || JSON.stringify(amountFields()) !== state.formSnapshot) {
    throw new Error("Chain, addresses, or amount changed after preflight. Discard this authorization and prepare again.");
  }
}
function setButtons() {
  $("sign").disabled = !state.preflight || state.dryRun || !state.preflight.broadcast.enabled || Boolean(state.txHash);
  $("submit").disabled = !state.signature || Boolean(state.txHash);
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
  if (state.victim && state.victim.toLowerCase() !== accounts[0].toLowerCase()) {
    state.preflight = null;
    state.signature = null;
    state.calldata = null;
    state.txHash = null;
    state.formSnapshot = null;
    state.transferProof = null;
  }
  state.victim = accounts[0];
  state.activeAccount = accounts[0];
  $("victim-connected").textContent = state.victim;
  $("victim-connected").style.color = "#a9d8bc";
}

async function ensureWalletChain(expected) {
  const expectedHex = `0x${BigInt(expected).toString(16)}`;
  if (state.walletChainId && BigInt(state.walletChainId) === BigInt(expected)) return;
  await requireWallet().request({ method: "wallet_switchEthereumChain", params: [{ chainId: expectedHex }] });
  state.walletChainId = expectedHex;
}

async function prepare(isDryRun) {
  if (!state.victim) await connectVictim();
  if (state.activeAccount?.toLowerCase() !== state.victim.toLowerCase()) throw new Error("Select the victim account in your wallet before preflight");
  const fields = amountFields();
  const result = await api("/api/preflight", fields);
  state.preflight = result.result;
  state.signature = null;
  state.calldata = null;
  state.txHash = null;
  state.submissionCheck = null;
  state.verifyRequest = null;
  state.transferProof = null;
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
  if (state.activeAccount?.toLowerCase() !== p.addresses.victim.toLowerCase()) {
    throw new Error("Select the victim account in the wallet before signing");
  }
  await ensureWalletChain(p.chain.chainId);
  if (state.activeAccount?.toLowerCase() !== p.addresses.victim.toLowerCase()) throw new Error("Wallet account changed; select the victim account and prepare again");
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
  state.submissionCheck = null;
  setButtons();
  setStatus("Victim authorization is held in this page's memory. The signed call will be sent only to this loopback runner for simulation; switch the wallet account to the separate relayer EOA.");
  show("result", { signed: true, victim: p.addresses.victim, amount: p.amount.display, destination: p.addresses.destination, expiresAtUnix: p.authorization.validBefore, signatureSentToLocalRunner: false, signaturePersisted: false });
}

async function submitFromRelayer() {
  const p = state.preflight;
  if (!state.signature || !state.calldata || !p) throw new Error("Sign the authorization as the victim first");
  assertFormUnchanged();
  if (!p.broadcast.enabled) throw new Error(p.broadcast.reason);
  const wallet = requireWallet();
  if (state.activeAccount?.toLowerCase() !== p.addresses.relayer.toLowerCase()) {
    throw new Error("Switch the wallet to the separate relayer account before continuing");
  }
  if (!state.walletChainId || BigInt(state.walletChainId) !== BigInt(p.chain.chainId)) {
    throw new Error("Wallet network changed after signing. Discard this authorization and prepare a new one.");
  }

  const request = { from: p.addresses.relayer, to: p.token.address, data: state.calldata };
  const checked = await api("/api/submission-check", {
    chainKey: p.chain.key,
    victim: p.addresses.victim,
    destination: p.addresses.destination,
    relayer: p.addresses.relayer,
    amountBaseUnits: p.amount.baseUnits,
    nonce: p.authorization.nonce,
    calldata: state.calldata
  });
  const checkedState = checked.result;
  state.submissionCheck = checkedState;
  const estimate = asBigInt(checkedState.gas.estimatedUnits);
  const gasPrice = asBigInt(checkedState.gas.gasPriceWei);
  const relayerBefore = asBigInt(checkedState.balancesBefore.relayerNative);
  const victimBefore = asBigInt(checkedState.balancesBefore.victimNative);

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

  if (state.activeAccount?.toLowerCase() !== p.addresses.relayer.toLowerCase() || BigInt(state.walletChainId ?? "0x0") !== BigInt(p.chain.chainId)) {
    throw new Error("Wallet account or network changed after confirmation; transaction was not sent");
  }

  state.relayerBefore = relayerBefore.toString();
  const hash = await wallet.request({ method: "eth_sendTransaction", params: [{ ...request, gas: `0x${estimate.toString(16)}` }] });
  if (typeof hash !== "string") throw new Error("Wallet did not return a transaction hash");
  state.txHash = hash;
  const verifyRequest = {
    chainKey: p.chain.key,
    txHash: hash,
    victim: p.addresses.victim,
    destination: p.addresses.destination,
    relayer: p.addresses.relayer,
    nonce: p.authorization.nonce,
    amountBaseUnits: p.amount.baseUnits,
    calldata: state.calldata
  };
  state.verifyRequest = verifyRequest;
  setButtons();
  show("result", { txHash: hash, from: p.addresses.relayer, to: p.token.address, relayerBalanceBeforeWei: state.relayerBefore, victimNativeBeforeWei: victimBefore.toString(), broadcasted: true });
  setStatus("Transaction submitted by the relayer wallet. Waiting for receipt.");
  let post;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const verified = await api("/api/verify", verifyRequest);
    if (!verified.result.pending) { post = verified.result; break; }
    setStatus(`Waiting for the local runner to see the mainnet receipt… (${attempt + 1}/120)`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (!post) { setStatus("Receipt wait timed out. Keep the transaction hash; it may still mine. Retry verification later."); return; }
  const victimNativeAfter = asBigInt(post.balancesAfter.victimNative);
  const victimNativeBefore = victimBefore;
  const relayerNativeAfter = asBigInt(post.balancesAfter.relayerNative);
  const relayerSpend = relayerBefore - relayerNativeAfter;
  const victimNativeDelta = victimNativeAfter - victimNativeBefore;
  const victimPaidZeroNativeGas = victimNativeDelta === 0n;
  const relayerPaidGas = post.txFrom.toLowerCase() === p.addresses.relayer.toLowerCase() &&
    BigInt(post.gasUsed) > 0n && BigInt(post.executionFeeWei ?? "0") > 0n;
  state.transferProof = {
    originalTransfer: "PASS — confirmed receipt contains the exact victim-to-destination USDC transfer",
    txHash: state.txHash,
    amount: `${p.amount.display} USDC`,
    victimGasSpent: victimPaidZeroNativeGas ? "0 native ETH (PASS)" : `${victimNativeDelta.toString()} wei (FAIL — balance changed)`,
    victimPaidZeroNativeGas,
    relayerPaidGas: relayerPaidGas ? "PASS — relayer was the transaction sender and paid the receipt gas fee" : "FAIL — receipt does not prove the relayer paid gas",
    relayerGas: {
      sender: post.txFrom,
      gasUsed: post.gasUsed,
      effectiveGasPriceWei: post.effectiveGasPrice,
      receiptExecutionFeeWei: post.executionFeeWei,
      observedNativeBalanceSpendWei: relayerSpend.toString(),
      observedNativeBalanceSpendEth: formatNative(relayerSpend)
    },
    nonceConsumedAtReceiptBlock: post.authorizationUsed,
    authorizationUsedEvent: post.authorizationUsedEvent,
    receiptBlockNumber: post.receiptBlockNumber,
    receiptBlockTimestamp: post.receiptBlockTimestamp,
    signatureSentToLocalRunner: true,
    signaturePersisted: false,
    note: "Relayer balance delta can include concurrent activity. The receipt identifies the relayer as sender and reports the gas fee; victim zero-gas proof uses its native balance delta."
  };
  show("result", state.transferProof);
  if (!post.authorizationUsed) throw new Error("Receipt exists but the USDC contract did not mark the authorization nonce used");
  setButtons();
  setStatus("Original transfer confirmed. Immediately simulating the exact same authorization at its receipt block; no second transaction will be sent.");
  await verifyReplayRejection();
}

async function verifyReplayRejection() {
  if (!state.txHash || !state.calldata || !state.preflight || !state.verifyRequest) throw new Error("A successful authorization transaction is required first");
  assertFormUnchanged();
  try {
    const replay = (await api("/api/replay-check", state.verifyRequest)).result;
    const completePass = replay.pass && state.transferProof?.victimPaidZeroNativeGas && state.transferProof?.relayerPaidGas.startsWith("PASS");
    show("result", {
      ...state.transferProof,
      nonceConsumed: replay.authorizationUsed ? "PASS — true at the original receipt block" : "FAIL — nonce was not marked used",
      authorizationStillInsideOriginalValidityWindow: replay.authorizationInsideOriginalWindow
        ? `PASS — receipt-block timestamp ${replay.replayBlockTimestamp} is after validAfter ${replay.validAfter} and before validBefore ${replay.validBefore}`
        : `FAIL — receipt-block timestamp ${replay.replayBlockTimestamp} is outside validAfter ${replay.validAfter} and validBefore ${replay.validBefore}`,
      replaySimulationRejected: replay.replayRejected ? "PASS — exact original calldata reverted in read-only eth_call" : "FAIL — replay simulation did not revert",
      replayRejectedDueToConsumedNonce: replay.replayRejectedByConsumedNonce,
      replayRevertReasonIdentifiesConsumedNonce: replay.revertIdentifiesConsumedNonce,
      replaySimulationBlockNumber: replay.replayBlockNumber,
      replayTransactionBroadcast: false,
      replayProof: replay.pass ? "PASS — the consumed nonce caused replay rejection while the authorization remained inside its original validity window" : "FAIL — replay protection was not proven; no replay transaction was sent",
      overallTransferAndReplay: completePass ? "PASS" : "PARTIAL — inspect individual checks above"
    });
    setStatus(completePass
      ? "Original transfer PASS; victim gas spent = 0; relayer paid gas; nonce consumed; authorization still valid; same-authorization replay rejected by the consumed nonce. No second transaction was broadcast."
      : "Original transfer confirmed; one or more gasless-transfer or in-window replay checks did not pass. No second transaction was broadcast.");
  } catch (error) {
    show("result", {
      ...state.transferProof,
      replayProof: "NOT PROVEN — immediate replay simulation did not complete",
      replaySimulationError: error.message,
      replayTransactionBroadcast: false
    });
    setStatus("Original transfer confirmed; immediate replay simulation did not complete. No second transaction was broadcast.");
  }
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
$("chain").addEventListener("change", () => { state.preflight = null; state.signature = null; state.calldata = null; state.txHash = null; state.submissionCheck = null; state.verifyRequest = null; state.transferProof = null; state.formSnapshot = null; setButtons(); });
provider?.on?.("chainChanged", (chainId) => {
  state.walletChainId = typeof chainId === "string" ? chainId : null;
  if (state.preflight && !state.dryRun && BigInt(state.walletChainId ?? "0x0") !== BigInt(state.preflight.chain.chainId)) {
    state.preflight = null;
    state.signature = null;
    state.calldata = null;
    state.txHash = null;
    state.submissionCheck = null;
    state.verifyRequest = null;
    state.transferProof = null;
    state.formSnapshot = null;
  }
  setButtons();
  setStatus("Wallet network changed. Any signed authorization for the previous network was discarded.");
});
provider?.on?.("accountsChanged", (accounts) => {
  const current = Array.isArray(accounts) ? accounts[0] : null;
  state.activeAccount = current;
  const isParticipant = current && state.preflight && [state.preflight.addresses.victim, state.preflight.addresses.relayer]
    .some((address) => address.toLowerCase() === current.toLowerCase());
  if (state.preflight && !isParticipant) {
    state.preflight = null;
    state.signature = null;
    state.calldata = null;
    state.txHash = null;
    state.submissionCheck = null;
    state.verifyRequest = null;
    state.formSnapshot = null;
    setButtons();
    setStatus("Wallet account changed to an address outside this test. Reconnect the victim and prepare a fresh authorization.");
    return;
  }
  setStatus(current ? `Wallet account changed to ${current}.` : "Wallet disconnected.");
});
initialize().catch((error) => setStatus(`Could not load runner config: ${error.message}`));
