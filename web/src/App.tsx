import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAddress } from "viem";
import { useAccount, useConnect, useDisconnect, useSignTypedData, useSwitchChain } from "wagmi";
import {
  checkAgentHealth,
  checkAgentPath,
  createAgentPath,
  createJob,
  createQuote,
  formatBaseUnits,
  getAgentCapabilities,
  getApiHealth,
  getJob,
  prepareAuthorization,
  scanBalances,
  shortAddress,
  submitAuthorization,
  toBaseUnits
} from "./api";
import { chainMetadata } from "./wagmi";
import type { AgentCapabilities, AgentPath, AuthorizationEnvelope, ChainBalance, ChainKey, RescueJob, RescueLeg, ScanResult } from "./types";

type PendingSignatures = { signature: `0x${string}`; routeSignature: `0x${string}`; expiresAt: number };

const chainKeys: ChainKey[] = ["base", "arbitrum"];
const explorerFor: Record<ChainKey, string> = { base: chainMetadata.base.explorer, arbitrum: chainMetadata.arbitrum.explorer };
const steps = ["Connect", "Review", "Authorize", "Track"];

const statusCopy: Record<string, { label: string; tone: string }> = {
  discovered: { label: "Ready to quote", tone: "neutral" },
  quoted: { label: "Quote ready", tone: "blue" },
  quote_expired: { label: "Quote expired", tone: "amber" },
  awaiting_authorization: { label: "Waiting for your signature", tone: "amber" },
  submitting: { label: "Relayer submitting", tone: "blue" },
  submitted: { label: "Source transfer pending", tone: "blue" },
  source_confirmed: { label: "USDC transfer confirmed", tone: "green" },
  converting: { label: "NEAR Intents processing", tone: "blue" },
  under_review: { label: "Provider review", tone: "amber" },
  zec_received: { label: "ZEC received · shielding unverified", tone: "amber" },
  shielding: { label: "Shielding unverified", tone: "amber" },
  completed: { label: "Complete", tone: "green" },
  refunded: { label: "Refunded to clean wallet", tone: "amber" },
  failed: { label: "Failed · review before retry", tone: "red" },
  needs_review: { label: "Needs careful review", tone: "red" }
};

const apiErrorCopy: Record<string, string> = {
  SERVICE_UNAVAILABLE: "The rescue API could not be reached. Check that the backend is running and configured.",
  REQUEST_TIMED_OUT: "The request timed out. Refresh job status before retrying any transaction step.",
  RELAYER_NOT_CONFIGURED: "The server relayer is not configured. No transaction was submitted.",
  RESCUE_ROUTER_NOT_CONFIGURED: "A reviewed RescueRouter deployment is not configured. Signing and submission are blocked.",
  CHAIN_TOKEN_OR_ROUTER_VALIDATION_FAILED: "The chain, native USDC, or pinned router checks did not pass. No transaction was submitted.",
  ROUTER_CODE_OR_TOKEN_MISMATCH: "The deployed router did not match the server's pinned configuration. No transaction was submitted.",
  QUOTE_EXPIRED_REFRESH_REQUIRED: "The quote expired. Request a fresh quote before signing.",
  BELOW_MINIMUM_RESCUE_AMOUNT: "This amount is below the configured rescue minimum.",
  MINIMUM_AMOUNT_NOT_MET: "The provider's minimum input amount was not met.",
  CURRENT_BALANCE_TOO_LOW: "The source wallet balance changed or no longer covers the quote and signed fee.",
  BASE_ROLLUP_FEE_ESTIMATE_UNAVAILABLE: "The Base rollup fee estimate is unavailable. The server failed closed.",
  RELAY_GAS_COST_EXCEEDS_CONFIGURED_CAP: "The estimated relayer gas cost exceeds the configured safety ceiling.",
  RELAYER_NATIVE_BALANCE_TOO_LOW: "The relayer does not have the required native-gas reserve.",
  INVALID_REIMBURSEMENT_AMOUNT: "Enter a positive fixed USDC reimbursement with up to six decimals.",
  REFUND_ADDRESS_MUST_DIFFER_FROM_SOURCE: "The clean refund wallet must differ from the compromised wallet.",
  TRANSPARENT_MAINNET_ZCASH_RECIPIENT_REQUIRED: "Enter a valid Zcash mainnet transparent t1 receiver.",
  LEG_STATE_CHANGED: "This chain leg changed while the request was in progress. Refresh status before continuing."
};

function messageFor(error: unknown): string {
  const code = error instanceof Error ? error.message : "UNEXPECTED_FAILURE";
  return apiErrorCopy[code] ?? `The request did not complete (${code}). Check the status before retrying.`;
}

function isCleanAddress(value: string, source?: string): boolean {
  return isAddress(value, { strict: false }) && value.toLowerCase() !== source?.toLowerCase();
}

function parseUsdc(value: string): string {
  const baseUnits = toBaseUnits(value.trim());
  if (BigInt(baseUnits) < 1_000_000n) throw new Error("Use at least 1.00 USDC for a quote.");
  return baseUnits;
}

function isTAddress(value: string): boolean {
  return /^t1[1-9A-HJ-NP-Za-km-z]{33}$/.test(value.trim());
}

function legFor(job: RescueJob | null, chain: ChainKey): RescueLeg | undefined {
  return job?.legs.find((leg) => leg.chainKey === chain);
}

function currentStep(connected: boolean, scanned: boolean, hasJob: boolean): number {
  if (!connected) return 0;
  if (!scanned || !hasJob) return 1;
  return 2;
}

function Icon({ name, size = 18 }: { name: "shield" | "arrow" | "check" | "warning" | "link" | "refresh"; size?: number }) {
  const paths = {
    shield: <><path d="M12 3 20 6v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-4.8"/></>,
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    warning: <><path d="m10.4 4.4-8 13.8A1.2 1.2 0 0 0 3.5 20h17a1.2 1.2 0 0 0 1.1-1.8l-8-13.8a1.9 1.9 0 0 0-3.2 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M4.5 9A8 8 0 0 1 18 5l2 2"/><path d="M4 17v-5h5"/><path d="M19.5 15A8 8 0 0 1 6 19l-2-2"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function StatusPill({ status }: { status: string }) {
  const copy = statusCopy[status] ?? { label: status.replaceAll("_", " "), tone: "neutral" };
  return <span className={`status-pill status-${copy.tone}`}><span className="status-dot" />{copy.label}</span>;
}

function App() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { mutateAsync: signTypedData, isPending: walletSigning } = useSignTypedData();
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [job, setJob] = useState<RescueJob | null>(null);
  const [selected, setSelected] = useState<ChainKey[]>(["base", "arbitrum"]);
  const [refundAddress, setRefundAddress] = useState("");
  const [amounts, setAmounts] = useState<Record<ChainKey, string>>({ base: "", arbitrum: "" });
  const [reimbursements, setReimbursements] = useState<Record<ChainKey, string>>({ base: "", arbitrum: "" });
  const [receivers, setReceivers] = useState<Record<ChainKey, string>>({ base: "", arbitrum: "" });
  const [envelopes, setEnvelopes] = useState<Partial<Record<ChainKey, AuthorizationEnvelope>>>({});
  const [signatures, setSignatures] = useState<Partial<Record<ChainKey, PendingSignatures>>>({});
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null);
  const [agentToken, setAgentToken] = useState("");
  const [agentCapabilities, setAgentCapabilities] = useState<AgentCapabilities | null>(null);
  const [agentPaths, setAgentPaths] = useState<Partial<Record<ChainKey, AgentPath>>>({});
  const [agentPathStatuses, setAgentPathStatuses] = useState<Partial<Record<ChainKey, string>>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmChain, setConfirmChain] = useState<ChainKey | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const idempotencyRef = useRef(crypto.randomUUID());

  const refundValid = useMemo(() => isCleanAddress(refundAddress.trim(), address), [refundAddress, address]);
  const selectedAvailable = useMemo(() => (scan?.chains ?? []).filter((item) => selected.includes(item.chainKey) && item.status === "available" && BigInt(item.balanceBaseUnits) > 0n), [scan, selected]);
  const shouldPoll = Boolean(job?.legs.some((leg) => ["submitted", "source_confirmed", "converting", "under_review", "needs_review"].includes(leg.status)));
  const activeLegForConfirmation = confirmChain ? legFor(job, confirmChain) : undefined;

  useEffect(() => {
    let cancelled = false;
    getApiHealth().then(() => { if (!cancelled) setApiOnline(true); }).catch(() => { if (!cancelled) setApiOnline(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!shouldPoll || !job?.jobId) return;
    let active = true;
    const timer = window.setInterval(() => {
      getJob(job.jobId).then((fresh) => { if (active) setJob(fresh); }).catch(() => undefined);
    }, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [job?.jobId, shouldPoll]);

  useEffect(() => {
    if (!address) return;
    setScan(null);
    setJob(null);
    setEnvelopes({});
    setSignatures({});
    setReceivers({ base: "", arbitrum: "" });
    setAgentPaths({});
  }, [address]);

  const runAction = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusyAction(label);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusyAction(null);
    }
  }, []);

  async function handleConnect() {
    const connector = connectors[0];
    if (!connector) return setError("No injected EVM wallet was found. Install or enable Rabby or another supported wallet.");
    setError(null);
    try { await connect({ connector }); } catch (caught) { setError(messageFor(caught)); }
  }

  async function handleScan() {
    if (!address) return;
    await runAction("scan", async () => {
      const result = await scanBalances(address);
      setScan(result);
      setJob(null);
      setEnvelopes({});
      setSignatures({});
      idempotencyRef.current = crypto.randomUUID();
    });
  }

  function toggleChain(chain: ChainKey) {
    setSelected((current) => current.includes(chain) ? current.filter((value) => value !== chain) : [...current, chain]);
    setJob(null);
    setEnvelopes((current) => ({ ...current, [chain]: undefined }));
    setSignatures((current) => ({ ...current, [chain]: undefined }));
  }

  async function ensureJob(): Promise<RescueJob> {
    if (!address) throw new Error("Connect the compromised wallet first.");
    if (!refundValid) throw new Error("Enter a clean EVM refund address that you control and that differs from the compromised wallet.");
    if (selected.length === 0) throw new Error("Select at least one chain.");
    if (job && job.sourceAddress.toLowerCase() === address.toLowerCase() && job.cleanRefundAddress.toLowerCase() === refundAddress.trim().toLowerCase()) return job;
    const created = await createJob({
      sourceAddress: address,
      cleanRefundAddress: refundAddress.trim(),
      selectedChains: selected,
      idempotencyKey: idempotencyRef.current
    });
    setJob(created);
    return created;
  }

  async function handleQuote(chain: ChainKey) {
    await runAction(`quote-${chain}`, async () => {
      const receiver = receivers[chain].trim();
      if (!isTAddress(receiver)) throw new Error(`Enter a valid public t1 receiver for ${chainMetadata[chain].name}. Keep the Base and Arbitrum receivers separate.`);
      const amount = parseUsdc(amounts[chain]);
      const currentJob = await ensureJob();
      await createQuote(currentJob.jobId, chain, amount, receiver);
      const fresh = await getJob(currentJob.jobId);
      setJob(fresh);
      setEnvelopes((current) => ({ ...current, [chain]: undefined }));
      setSignatures((current) => ({ ...current, [chain]: undefined }));
      setNotice(`${chainMetadata[chain].name} quote received. Review the output, fees, refund target, and expiry before continuing.`);
    });
  }

  async function handleAgentConnect() {
    await runAction("agent", async () => {
      const health = await checkAgentHealth();
      setAgentOnline(health.status === "ok" && health.network === "mainnet");
      if (!agentToken.trim()) throw new Error("Enter the local companion token from its terminal. It stays in this browser tab and is never sent to the hosted API.");
      const caps = await getAgentCapabilities(agentToken.trim());
      setAgentCapabilities(caps);
      setNotice(caps.verification === "verified"
        ? "Local wallet layer verified. Receiver tools are available for this session."
        : "Local companion is reachable, but its wallet commands are not live-verified. The app will not use it to claim a ZEC receipt or shielded balance.");
    });
  }

  async function handleAgentPath(chain: ChainKey) {
    await runAction(`agent-path-${chain}`, async () => {
      if (agentCapabilities?.verification !== "verified" || !agentCapabilities.canGenerateTransparentReceiver) {
        throw new Error("The configured wallet layer is not verified for automatic receiver generation. Enter a public receiver generated in Zingo PC instead.");
      }
      const path = await createAgentPath(agentToken.trim(), chain);
      setAgentPaths((current) => ({ ...current, [chain]: path }));
      setReceivers((current) => ({ ...current, [chain]: path.address }));
      setAgentPathStatuses((current) => ({ ...current, [chain]: "Receiver created locally; incoming status not checked." }));
    });
  }

  async function handleAgentStatus(chain: ChainKey) {
    const path = agentPaths[chain];
    if (!path) return;
    await runAction(`agent-status-${chain}`, async () => {
      const status = await checkAgentPath(agentToken.trim(), path.pathId);
      setAgentPathStatuses((current) => ({ ...current, [chain]: status.state === "received"
        ? `${formatBaseUnits(status.amountZatoshis, 8, 8)} ZEC reported by the local adapter. Verify the wallet transaction before treating it as confirmed.`
        : "No matching transparent balance reported by the local adapter. This is not a completed-sync proof." }));
    });
  }

  async function handlePrepare(chain: ChainKey) {
    await runAction(`prepare-${chain}`, async () => {
      const leg = legFor(job, chain);
      if (!job || !leg?.intentQuote) throw new Error("Request and review a quote before preparing authorization.");
      const reimbursement = toBaseUnits(reimbursements[chain].trim());
      const envelope = await prepareAuthorization(job.jobId, chain, reimbursement);
      setEnvelopes((current) => ({ ...current, [chain]: envelope }));
      setSignatures((current) => ({ ...current, [chain]: undefined }));
      const fresh = await getJob(job.jobId);
      setJob(fresh);
      setNotice("Exact amount, router, destination, two nonces, and 300-second expiry are ready for review. No signature was requested yet.");
    });
  }

  async function handleSign(chain: ChainKey) {
    if (!address || !job) return;
    const envelope = envelopes[chain];
    if (!envelope) return;
    await runAction(`sign-${chain}`, async () => {
      if (address.toLowerCase() !== job.sourceAddress.toLowerCase()) throw new Error("Reconnect the same source wallet used to scan this rescue job.");
      if (chainId !== envelope.chain.chainId) await switchChainAsync({ chainId: envelope.chain.chainId });
      const authSignature = await signTypedData({
        account: address,
        chainId: envelope.chain.chainId,
        domain: envelope.domain,
        types: envelope.types,
        primaryType: envelope.primaryType,
        message: envelope.authorization as never
      } as never);
      const routeSignature = await signTypedData({
        account: address,
        chainId: envelope.chain.chainId,
        domain: envelope.routeConsent.domain,
        types: envelope.routeConsent.types,
        primaryType: "RescueRoute",
        message: envelope.routeConsent.message as never
      } as never);
      const expiresAt = Number((envelope.authorization.validBefore as string | number | bigint) ?? 0) * 1000;
      setSignatures((current) => ({ ...current, [chain]: { signature: authSignature, routeSignature, expiresAt } }));
      setNotice("Both signatures are held only in memory in this tab. They have not been sent to the backend or submitted on-chain.");
    });
  }

  async function handleSubmit(chain: ChainKey) {
    if (!job) return;
    const signed = signatures[chain];
    if (!signed) return;
    if (signed.expiresAt <= Date.now()) {
      setSignatures((current) => ({ ...current, [chain]: undefined }));
      setEnvelopes((current) => ({ ...current, [chain]: undefined }));
      setConfirmChain(null);
      setError("The authorization expired. Refresh the quote and prepare a new exact authorization; the old signatures were cleared from memory.");
      return;
    }
    await runAction(`submit-${chain}`, async () => {
      const updated = await submitAuthorization(job.jobId, chain, signed.signature, signed.routeSignature, crypto.randomUUID());
      setJob(updated);
      setSignatures((current) => ({ ...current, [chain]: undefined }));
      setConfirmChain(null);
      setNotice("The relayer request was accepted. Refresh status to verify the source transaction and provider state.");
    });
    setSignatures((current) => ({ ...current, [chain]: undefined }));
    setConfirmChain(null);
  }

  async function handleRefresh() {
    if (!job) return;
    await runAction("refresh", async () => {
      const updated = await getJob(job.jobId);
      setJob(updated);
      setNotice("Status refreshed from the backend and configured chains/provider. Local ZEC and shielding remain separate checks.");
    });
  }

  function amountInput(chain: ChainKey, balance?: ChainBalance) {
    return <div className="amount-control">
      <label htmlFor={`${chain}-amount`}>Amount to quote <span>USDC</span></label>
      <input id={`${chain}-amount`} inputMode="decimal" placeholder="0.00" value={amounts[chain]} onChange={(event) => setAmounts((current) => ({ ...current, [chain]: event.target.value }))} />
      <p className="field-hint">Available: {balance?.balance ?? "—"} USDC · quote minimum 1 USDC</p>
    </div>;
  }

  function renderQuoteAndAuthorize(chain: ChainKey, balance?: ChainBalance) {
    const leg = legFor(job, chain);
    const quote = leg?.intentQuote;
    const quoteExpiredLocally = Boolean(quote && Date.parse(quote.expiresAt) <= nowMs);
    const envelope = envelopes[chain];
    const signed = signatures[chain];
    return <section className={`chain-card chain-${chain}`} key={chain}>
      <div className="chain-card-top">
        <div className="chain-identity"><span className={`chain-mark mark-${chain}`}>{chain === "base" ? "B" : "A"}</span><div><h3>{chainMetadata[chain].name}</h3><p>Native Circle USDC · mainnet</p></div></div>
        {leg ? <StatusPill status={leg.status} /> : <span className="status-pill status-neutral">Not started</span>}
      </div>
      <div className="chain-balance"><span>Detected balance</span><strong>{balance?.balance ?? "—"} <small>USDC</small></strong></div>
      {amountInput(chain, balance)}
      <div className="receiver-control">
        <label htmlFor={`${chain}-receiver`}>Zcash receiver <span>unique public t1 per chain</span></label>
        <input id={`${chain}-receiver`} autoComplete="off" spellCheck={false} placeholder="Enter this chain’s Zingo PC t1 receiver" value={receivers[chain]} onChange={(event) => setReceivers((current) => ({ ...current, [chain]: event.target.value.trim() }))} />
        {agentPaths[chain] ? <div className="inline-local-state"><span>{agentPathStatuses[chain] ?? "Locally generated receiver"}</span><button type="button" className="text-button" onClick={() => void handleAgentStatus(chain)} disabled={Boolean(busyAction)}>Check local wallet</button></div> : <p className="field-hint">Transparent t1 only at the provider boundary. ZEC remains public until a verified shield flow.</p>}
      </div>

      {!quote && <button className="button button-secondary button-wide" type="button" disabled={!scan || !refundValid || !isTAddress(receivers[chain]) || !amounts[chain] || Boolean(busyAction)} onClick={() => void handleQuote(chain)}>
        {busyAction === `quote-${chain}` ? "Requesting live quote…" : "Request live quote"}<Icon name="arrow" />
      </button>}

      {quote && <div className="quote-panel">
        <div className="quote-panel-heading"><div><span className="eyebrow">LIVE PROVIDER QUOTE</span><strong>{quote.amountOutFormatted ?? `${formatBaseUnits(quote.amountOutBaseUnits, 8, 8)} ZEC`}</strong><span>expected ZEC output</span></div><StatusPill status={leg?.status ?? "quoted"} /></div>
        <div className="quote-facts">
          <div><span>USDC input</span><strong>{formatBaseUnits(quote.amountInBaseUnits)} USDC</strong></div>
          {quote.minimumAmountInBaseUnits && <div><span>Provider minimum</span><strong>{formatBaseUnits(quote.minimumAmountInBaseUnits)} USDC</strong></div>}
          <div><span>Minimum output</span><strong>{quote.minimumAmountOutBaseUnits ? `${formatBaseUnits(quote.minimumAmountOutBaseUnits, 8, 8)} ZEC` : "Not returned"}</strong></div>
          <div><span>Slippage tolerance</span><strong>{(quote.slippageToleranceBps / 100).toFixed(2)}%</strong></div>
          <div><span>Quote expiry</span><strong>{quoteExpiredLocally ? "Expired · refresh status" : new Date(quote.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</strong></div>
          <div><span>Refund wallet</span><strong title={refundAddress}>{shortAddress(refundAddress)}</strong></div>
          <div><span>Provider deposit</span><strong title={quote.depositAddress}>{shortAddress(quote.depositAddress)}</strong></div>
        </div>
        {(quote.refundFeeBaseUnits || quote.withdrawFeeBaseUnits) && <details className="fee-details"><summary>Provider fee fields</summary><p>Provider-reported raw base units (kept in provider units because the route does not identify a display currency): refund {quote.refundFeeBaseUnits ?? "not returned"} · withdrawal {quote.withdrawFeeBaseUnits ?? "not returned"}.</p></details>}
        {leg?.providerStatus && <div className={`provider-notice ${leg.providerStatus === "UNDER_REVIEW" ? "is-review" : ""}`}><span>Provider status</span><strong>{leg.providerStatus === "SUCCESS" ? "Provider says conversion completed; local ZEC is not verified." : leg.providerStatus.replaceAll("_", " ")}</strong></div>}
        {leg?.transactionHash && <a className="tx-link" href={`${explorerFor[chain]}/tx/${leg.transactionHash}`} target="_blank" rel="noreferrer">View source transaction <Icon name="link" size={15} /></a>}
        {leg?.status === "refunded" && <p className="refund-note">The quote specified this clean wallet on {chainMetadata[chain].name}: {refundAddress}.</p>}
        {quoteExpiredLocally && leg?.status === "quoted" && <button type="button" className="button button-secondary button-wide refresh-quote-button" disabled={Boolean(busyAction)} onClick={() => void handleRefresh()}>Refresh status to unlock a new quote <Icon name="refresh" size={16} /></button>}
        {leg?.status === "quote_expired" && <button type="button" className="button button-secondary button-wide refresh-quote-button" disabled={Boolean(busyAction)} onClick={() => void handleQuote(chain)}>Request a fresh quote <Icon name="refresh" size={16} /></button>}
      </div>}

      {quote && <div className="reimbursement-box">
        <div className="reimbursement-title"><span className="mini-icon">↗</span><div><strong>Relayer reimbursement</strong><p>A fixed USDC amount the relayer receives, signed by you.</p></div></div>
        <label htmlFor={`${chain}-reimbursement`}>Fixed amount <span>USDC</span></label>
        <input id={`${chain}-reimbursement`} inputMode="decimal" placeholder="Set after fee review" value={reimbursements[chain]} onChange={(event) => setReimbursements((current) => ({ ...current, [chain]: event.target.value }))} />
        <p className="field-hint">This is not an exact on-chain conversion of gas cost. The server enforces its configured cap.</p>
        {!envelope && <button type="button" className="button button-secondary button-wide" disabled={!reimbursements[chain] || Boolean(busyAction)} onClick={() => void handlePrepare(chain)}>{busyAction === `prepare-${chain}` ? "Checking route…" : "Prepare exact authorization"}</button>}
      </div>}

      {envelope && <div className="authorization-summary">
        <div className="summary-heading"><span className="secure-icon"><Icon name="shield" /></span><div><strong>Review before signing</strong><p>Two signatures · valid for 5 minutes</p></div></div>
        <div className="summary-list">
          <div><span>Chain</span><strong>{chainMetadata[chain].name} mainnet</strong></div>
          <div><span>Circle USDC contract</span><strong title={envelope.chain.token}>{shortAddress(envelope.chain.token)}</strong></div>
          <div><span>Total authorized</span><strong>{formatBaseUnits(envelope.totalAuthorizedAmountBaseUnits)} USDC</strong></div>
          <div><span>Signed router recipient</span><strong title={envelope.routerAddress}>{shortAddress(envelope.routerAddress)}</strong></div>
          <div><span>Provider deposit</span><strong title={envelope.depositAddress}>{shortAddress(envelope.depositAddress)}</strong></div>
          <div><span>Fixed relayer fee</span><strong>{formatBaseUnits(envelope.reimbursement.amountBaseUnits)} USDC</strong></div>
          <div><span>Wallet gas</span><strong className="good-text">You pay 0 native gas</strong></div>
          <div><span>Nonce / expiry</span><strong>{shortAddress(envelope.authorization.nonce as string, 4)} · {new Date(Number(envelope.authorization.validBefore) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</strong></div>
        </div>
        <p className="disclaimer-small">{envelope.reimbursement.estimateDisclaimer}</p>
        {!signed ? <button type="button" className="button button-primary button-wide" disabled={!isConnected || walletSigning || Boolean(busyAction)} onClick={() => void handleSign(chain)}>{busyAction === `sign-${chain}` || walletSigning ? "Waiting for wallet…" : "Sign both authorizations"}</button> : <>
          <p className="signed-state"><Icon name="check" size={16} /> Signatures ready in this tab · expires {new Date(signed.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
          <button type="button" className="button button-danger button-wide" disabled={Boolean(busyAction)} onClick={() => setConfirmChain(chain)}>Review and submit from relayer <Icon name="arrow" /></button>
        </>}
      </div>}
    </section>;
  }

  const step = currentStep(isConnected, Boolean(scan), Boolean(job));

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="ZecRescue home"><span className="brand-mark"><Icon name="shield" size={21} /></span><span>ZecRescue</span><span className="brand-beta">RECOVERY PREVIEW</span></a>
      <div className="topbar-right"><span className={`api-indicator ${apiOnline ? "online" : apiOnline === false ? "offline" : "checking"}`}><span />{apiOnline ? "Rescue API online" : apiOnline === false ? "API unavailable" : "Checking API"}</span>{isConnected ? <button type="button" className="wallet-chip" onClick={() => disconnect()}><span className="wallet-chip-dot" />{shortAddress(address)}<span className="wallet-chip-close">×</span></button> : <button type="button" className="button button-primary button-small" onClick={() => void handleConnect()} disabled={connecting}>{connecting ? "Connecting…" : "Connect wallet"}</button>}</div>
    </header>

    <main id="top">
      <section className="hero-section">
        <div className="hero-copy">
          <div className="hero-kicker"><span className="kicker-line" />NON-CUSTODIAL WALLET RECOVERY</div>
          <h1>Move first.<br /><em>Shield next.</em></h1>
          <p className="hero-lede">Move native USDC out of a compromised wallet without funding it with ETH. Your wallet signs a precise authorization. A separate relayer pays the network fee.</p>
          <div className="hero-proof-points"><span><Icon name="check" size={15} /> No victim gas</span><span><Icon name="check" size={15} /> Keys stay yours</span><span><Icon name="check" size={15} /> Base + Arbitrum</span></div>
        </div>
        <aside className="hero-card">
          <div className="hero-card-icon"><Icon name="shield" size={23} /></div>
          <div className="hero-card-label">THE RECOVERY PATH</div>
          <div className="path-step"><span className="path-step-number">01</span><span>Native USDC<small>Base or Arbitrum</small></span><b>→</b></div>
          <div className="path-step"><span className="path-step-number">02</span><span>NEAR Intents<small>USDC to ZEC</small></span><b>→</b></div>
          <div className="path-step path-final"><span className="path-step-number">03</span><span>Zcash Recovery Vault<small>Local wallet · shielded target</small></span><Icon name="shield" size={17} /></div>
          <p>Transparent ZEC is public until it is actually shielded.</p>
        </aside>
      </section>

      <div className="validation-banner"><div className="banner-symbol"><Icon name="warning" size={19} /></div><div><strong>Pending final funded validation</strong><p>Live Base and Arbitrum USDC → ZEC, ZEC detection, and Ironwood-compatible shielding still need funded end-to-end proof. No real-money tests run during this build.</p></div><span className="banner-tag">PHASE 0 GATE</span></div>

      <nav className="journey-nav" aria-label="Recovery steps">{steps.map((item, index) => <div key={item} className={`journey-step ${index < step ? "done" : index === step ? "active" : ""}`}><span>{index < step ? <Icon name="check" size={13} /> : `0${index + 1}`}</span><b>{item}</b></div>)}</nav>

      {error && <div role="alert" className="alert alert-error"><Icon name="warning" /><p>{error}</p><button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
      {notice && <div role="status" className="alert alert-notice"><Icon name="check" /><p>{notice}</p><button type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}>×</button></div>}

      <section className="workspace-grid">
        <div className="main-column">
          <section className="workspace-card connect-card">
            <div className="section-number">01</div><div className="section-content">
              <div className="section-heading"><div><span className="eyebrow">START HERE</span><h2>Connect the compromised wallet</h2><p>Connect only to read its public address and ask it to sign. No seed phrase or private key is ever requested.</p></div>{isConnected && <span className="connected-badge"><Icon name="check" size={15} /> Connected</span>}</div>
              {isConnected ? <div className="connected-address"><div><span>Connected EVM address</span><strong>{address}</strong><small>Current wallet network: {chainId === 8453 ? "Base" : chainId === 42161 ? "Arbitrum" : `Chain ${chainId}`}. Scans use the rescue API.</small></div><button className="button button-secondary" type="button" onClick={() => void handleScan()} disabled={Boolean(busyAction)}>{busyAction === "scan" ? "Scanning…" : "Scan Base + Arbitrum"}<Icon name="arrow" /></button></div> : <button className="button button-primary" type="button" onClick={() => void handleConnect()} disabled={connecting}>{connecting ? "Connecting…" : "Connect source wallet"}<Icon name="arrow" /></button>}
            </div>
          </section>

          {scan && <section className="workspace-card review-card">
            <div className="section-number">02</div><div className="section-content">
              <div className="section-heading"><div><span className="eyebrow">SCAN RESULTS</span><h2>Choose independent chain legs</h2><p>Only native Circle USDC is eligible. A failure on one chain does not stop the other.</p></div><span className="scan-address">{shortAddress(scan.sourceAddress, 7)}</span></div>
              <div className="chain-select-grid">{chainKeys.map((chain) => {
                const balance = scan.chains.find((item) => item.chainKey === chain);
                const checked = selected.includes(chain);
                return <label className={`select-chain-card ${checked ? "selected" : ""}`} key={chain}>
                  <input type="checkbox" checked={checked} onChange={() => toggleChain(chain)} />
                  <span className={`chain-mark mark-${chain}`}>{chain === "base" ? "B" : "A"}</span>
                  <span className="select-chain-copy"><strong>{chainMetadata[chain].name}</strong><small>{balance?.status === "available" ? `${balance.balance} native USDC` : balance?.errorCode ?? "Balance unavailable"}</small></span>
                  <span className="select-chain-check"><Icon name="check" size={14} /></span>
                </label>;
              })}</div>
              <div className="refund-field">
                <div><label htmlFor="refund-address">Clean EVM refund wallet</label><p>Refunds go to this address on the source chain. They never default to the compromised wallet.</p></div>
                <input id="refund-address" autoComplete="off" spellCheck={false} placeholder="0x… · a separate wallet you control" value={refundAddress} onChange={(event) => { setRefundAddress(event.target.value); setJob(null); setEnvelopes({}); setSignatures({}); }} aria-invalid={Boolean(refundAddress) && !refundValid} />
                {refundAddress && !refundValid && <small className="field-error">Enter a valid address different from the connected source.</small>}
              </div>
            </div>
          </section>}

          {scan && selectedAvailable.length > 0 && refundValid && <section className="quote-section">
            <div className="quote-section-heading"><div><span className="eyebrow">03 · REVIEW ROUTE</span><h2>Prepare each chain separately</h2></div><p>Quotes, receivers, and signatures stay independent by chain.</p></div>
            <div className="chain-cards">{selected.map((chain) => renderQuoteAndAuthorize(chain, scan.chains.find((item) => item.chainKey === chain)))}</div>
          </section>}

          {scan && selectedAvailable.length === 0 && <div className="empty-state"><span className="empty-symbol">∅</span><h3>No rescuable USDC found</h3><p>The API did not find an available native USDC balance on the selected chains. Check the source wallet and scan again.</p><button className="button button-secondary" type="button" onClick={() => void handleScan()}>Scan again <Icon name="refresh" size={16} /></button></div>}

          {job && <section className="workspace-card progress-card">
            <div className="section-number">04</div><div className="section-content">
              <div className="section-heading"><div><span className="eyebrow">RECOVERY STATUS</span><h2>Each chain, clearly tracked</h2><p>Provider completion does not mean your local ZEC receipt or shielding is verified.</p></div><button type="button" className="icon-button" onClick={() => void handleRefresh()} disabled={Boolean(busyAction)} aria-label="Refresh status"><Icon name="refresh" /></button></div>
              <div className="progress-leg-list">{job.legs.map((leg) => <div className="progress-leg" key={leg.chainKey}><span className={`chain-mark mark-${leg.chainKey}`}>{leg.chainKey === "base" ? "B" : "A"}</span><div className="progress-leg-main"><div className="progress-leg-top"><strong>{chainMetadata[leg.chainKey].name}</strong><StatusPill status={leg.status} /></div><p>{leg.providerStatus === "SUCCESS" ? "Provider conversion reported complete. Local ZEC receipt is still unverified." : leg.status === "refunded" ? `Refund specified to ${shortAddress(job.cleanRefundAddress)} on this source chain.` : leg.errorCode ? `Review code: ${leg.errorCode}` : "No inferred completion. This state comes from the API."}</p>{leg.transactionHash && <a className="tx-link" href={`${explorerFor[leg.chainKey]}/tx/${leg.transactionHash}`} target="_blank" rel="noreferrer">View source transaction <Icon name="link" size={14} /></a>}</div></div>)}</div>
              <div className="shield-blocked"><span><Icon name="shield" size={17} /></span><div><strong>Shielding is not enabled yet</strong><p>The current local light-wallet adapter is not live-verified for isolated receiving and Ironwood shielding. ZecRescue will not label a transparent ZEC receipt as private.</p></div></div>
            </div>
          </section>}
        </div>

        <aside className="side-column">
          <section className="side-card safety-card"><span className="side-card-icon"><Icon name="shield" size={20} /></span><span className="eyebrow">YOUR SAFETY, FIRST</span><h3>What ZecRescue never asks for</h3><ul><li><Icon name="check" size={14} /> Seed phrase</li><li><Icon name="check" size={14} /> Private key</li><li><Icon name="check" size={14} /> ETH in the compromised wallet</li></ul><div className="side-separator" /><p>The relayer pays native gas. The wallet owner signs the exact amount and route. No one can guarantee beating an attacker to the funds.</p></section>

          <section className="side-card agent-card"><div className="agent-card-header"><span className="local-icon">⌂</span><div><span className="eyebrow">LOCAL COMPANION</span><h3>Zcash light wallet</h3></div></div>
            <div className="agent-status-row"><span className={`agent-light ${agentOnline ? "is-online" : agentOnline === false ? "is-offline" : ""}`} />{agentOnline ? "Agent reachable on this device" : agentOnline === false ? "Agent not reachable" : "Not connected"}</div>
            {!agentOnline && <button type="button" className="button button-secondary button-wide" onClick={() => void runAction("agent-health", async () => { const health = await checkAgentHealth(); setAgentOnline(health.status === "ok" && health.network === "mainnet"); })} disabled={Boolean(busyAction)}>Check local agent</button>}
            {agentOnline && <>
              <label className="agent-token-label" htmlFor="agent-token">Local session token</label>
              <input id="agent-token" type="password" autoComplete="off" placeholder="From the local agent terminal" value={agentToken} onChange={(event) => setAgentToken(event.target.value)} />
              <button type="button" className="button button-secondary button-wide" onClick={() => void handleAgentConnect()} disabled={Boolean(busyAction) || !agentToken.trim()}>{busyAction === "agent" ? "Checking capabilities…" : "Check wallet capabilities"}</button>
            </>}
            {agentCapabilities && <div className={`capability-note ${agentCapabilities.verification === "verified" ? "verified" : "blocked"}`}><strong>{agentCapabilities.verification === "verified" ? "Wallet layer verified" : "Not live-verified"}</strong><p>{agentCapabilities.limitations[0] ?? "Shield preparation, signing, and broadcast are disabled."}</p></div>}
            {agentCapabilities?.verification === "verified" && <div className="agent-tools">{chainKeys.map((chain) => <button type="button" className="agent-path-button" key={chain} disabled={Boolean(busyAction) || !agentCapabilities.canGenerateTransparentReceiver} onClick={() => void handleAgentPath(chain)}>{agentPaths[chain] ? `${chainMetadata[chain].name} path ready` : `Create ${chainMetadata[chain].name} receiver`}</button>)}</div>}
            <p className="agent-footnote">The token stays in this tab's memory. It is sent only to the fixed loopback agent, never to the hosted API.</p>
          </section>

          <section className="side-card privacy-card"><span className="eyebrow">PRIVACY BOUNDARY</span><div className="privacy-boundary-line"><span className="boundary-public">TRANSPARENT</span><span className="boundary-arrow">→</span><span className="boundary-shielded">SHIELDED</span></div><p>Transparent ZEC is visible on-chain. Privacy is not retroactive and begins only after a locally verified shielded-pool transaction confirms.</p></section>
        </aside>
      </section>
    </main>

    <footer className="footer"><div className="footer-brand"><span className="brand-mark small"><Icon name="shield" size={16} /></span><strong>ZecRescue</strong></div><span>Recovery software · Not a guarantee of recovery</span><span className="footer-scope">V1 · Base + Arbitrum</span></footer>

    {confirmChain && activeLegForConfirmation && job && envelopes[confirmChain] && signatures[confirmChain] && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmChain(null); }}><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="modal-top-icon"><Icon name="warning" size={22} /></div><span className="eyebrow">FINAL REVIEW · {chainMetadata[confirmChain].name.toUpperCase()}</span><h2 id="confirm-title">Submit this exact rescue?</h2><p>The relayer will broadcast one transaction. Your wallet will not pay native gas.</p>
      <div className="modal-summary"><div><span>Wallet spending</span><strong>{formatBaseUnits(envelopes[confirmChain]!.totalAuthorizedAmountBaseUnits)} USDC</strong></div><div><span>Provider receives</span><strong>{formatBaseUnits(activeLegForConfirmation.intentQuote?.requestedAmountBaseUnits)} USDC</strong></div><div><span>Relayer receives</span><strong>{formatBaseUnits(envelopes[confirmChain]!.reimbursement.amountBaseUnits)} USDC</strong></div><div><span>Source wallet gas</span><strong className="good-text">0 native gas</strong></div><div><span>Clean refund wallet</span><strong>{shortAddress(job.cleanRefundAddress)}</strong></div></div>
      <p className="modal-warning">The attacker may still race this transaction. The fixed reimbursement is not guaranteed to equal actual gas cost. Do not continue unless every value above matches your intent.</p>
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setConfirmChain(null)}>Go back</button><button type="button" className="button button-danger" onClick={() => void handleSubmit(confirmChain)} disabled={Boolean(busyAction)}>{busyAction === `submit-${confirmChain}` ? "Submitting…" : "Confirm relayer submission"}<Icon name="arrow" /></button></div>
    </section></div>}
  </div>;
}

export default App;
