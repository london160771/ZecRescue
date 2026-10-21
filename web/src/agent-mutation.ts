/** Clear safety diagnostics synchronously before starting an agent mutation request. */
export function runWithInvalidatedAgentDiagnostics<T>(
  invalidateDiagnostics: () => void,
  request: () => Promise<T>
): Promise<T> {
  invalidateDiagnostics();
  return request();
}
