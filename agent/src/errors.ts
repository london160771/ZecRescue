export type ReceiverCreationDiagnostic = {
  stage: "inventory_before" | "native_create" | "inventory_after" | "response_parse" | "manifest_registration" | "wallet_save" | "wallet_reopen" | "manifest_write" | "complete" | "restart_required";
  classification: "native_rejected_before_mutation" | "receiver_created_response_parse_failed" | "manifest_registration_failed" | "unknown_failure" | "native_rejected_after_mutation_reconciled" | "success" | "restart_required_verification";
  receiverCountBefore: number | null;
  receiverCountAfter: number | null;
  nativeError?: {
    class: "Error" | "TypeError" | "RangeError" | "ReferenceError" | "SyntaxError" | "NativeError";
    category: "LIGHTWALLETD_NOT_INITIALIZED" | "WALLET_STATE_LOCKED" | "NATIVE_OPERATION_REJECTED";
    code?: string;
  };
};

export class AgentError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly receiverCreationDiagnostic?: ReceiverCreationDiagnostic
  ) {
    super(code);
    this.name = "AgentError";
  }
}
