import type { RescueJob, RescueLeg } from "./jobs.js";

export type WorkflowStatus = "awaiting_user_action" | "in_progress" | "partial_success" | "completed" | "failed" | "needs_attention";

export function summarizeWorkflow(job: Pick<RescueJob, "legs">) {
  const statuses = job.legs.map((leg) => leg.status);
  const completedLegs = statuses.filter((status) => status === "completed").length;
  const failedLegs = statuses.filter((status) => status === "failed").length;
  const refundedLegs = statuses.filter((status) => status === "refunded").length;
  const needsReviewLegs = statuses.filter((status) => status === "needs_review").length;
  const terminalFailureLegs = failedLegs + refundedLegs;
  const allDone = statuses.length > 0 && completedLegs === statuses.length;
  const allFailed = statuses.length > 0 && terminalFailureLegs === statuses.length;

  let status: WorkflowStatus;
  if (allDone) status = "completed";
  else if (completedLegs > 0 && (terminalFailureLegs > 0 || needsReviewLegs > 0)) status = "partial_success";
  else if (needsReviewLegs > 0) status = "needs_attention";
  else if (allFailed) status = "failed";
  else if (statuses.every((value) => ["discovered", "quoted", "quote_expired", "awaiting_authorization"].includes(value))) {
    status = "awaiting_user_action";
  } else status = "in_progress";

  return {
    status,
    totalLegs: statuses.length,
    completedLegs,
    failedLegs,
    refundedLegs,
    needsReviewLegs,
    legs: job.legs.map((leg) => summarizeLeg(leg))
  };
}

function summarizeLeg(leg: RescueLeg) {
  let stage: string;
  let nextAction: string;
  switch (leg.status) {
    case "discovered":
      stage = "balance_discovered";
      nextAction = "create_quote";
      break;
    case "quoted":
      stage = "quote_ready";
      nextAction = "review_quote";
      break;
    case "quote_expired":
      stage = "quote_expired";
      nextAction = "request_fresh_quote";
      break;
    case "awaiting_authorization":
      stage = "awaiting_user_signature";
      nextAction = "sign_authorization";
      break;
    case "submitting":
    case "submitted":
      stage = "source_transaction_pending";
      nextAction = "wait_for_source_confirmation";
      break;
    case "source_confirmed":
      stage = "source_confirmed";
      nextAction = "monitor_provider";
      break;
    case "converting":
      stage = leg.providerStatus === "SUCCESS" ? "provider_done_zec_unverified" : "provider_converting";
      nextAction = leg.providerStatus === "SUCCESS" ? "verify_local_zec_receipt" : "monitor_provider";
      break;
    case "under_review":
      stage = "provider_review";
      nextAction = "wait_for_provider_review";
      break;
    case "zec_received":
      stage = "zec_received_shield_unverified";
      nextAction = "shielding_blocked_until_wallet_support_is_verified";
      break;
    case "shielding":
      stage = "shielding_pending";
      nextAction = "wait_for_local_shield_status";
      break;
    case "completed":
      stage = "completed";
      nextAction = "none";
      break;
    case "refunded":
      stage = "refunded";
      nextAction = "verify_clean_refund_address";
      break;
    case "failed":
      stage = "failed";
      nextAction = "review_failure_before_any_retry";
      break;
    case "needs_review":
      stage = "needs_review";
      nextAction = "manual_reconciliation";
      break;
  }

  return {
    chainKey: leg.chainKey,
    status: leg.status,
    stage,
    nextAction,
    providerStatus: leg.providerStatus,
    zecReceipt: "not_verified_by_orchestrator",
    shieldStatus: "disabled_pending_wallet_verification",
    updatedAt: leg.updatedAt.toISOString()
  };
}
