/** Clear safety diagnostics synchronously before starting an agent mutation request. */
export function runWithInvalidatedAgentDiagnostics<T>(
  invalidateDiagnostics: () => void,
  request: () => Promise<T>
): Promise<T> {
  invalidateDiagnostics();
  return request();
}

/** Commit neither result unless both fresh reads succeed. Diagnostics go first
 * because that serialized agent operation waits behind any timed-out mutation. */
export async function refreshAgentSafetyState<D, C>(
  invalidateDiagnostics: () => void,
  readDiagnostics: () => Promise<D>,
  readCapabilities: () => Promise<C>,
  applyFreshState: (state: { diagnostics: D; capabilities: C }) => void
): Promise<void> {
  invalidateDiagnostics();
  const diagnostics = await readDiagnostics();
  const capabilities = await readCapabilities();
  applyFreshState({ diagnostics, capabilities });
}
