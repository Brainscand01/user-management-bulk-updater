/**
 * Fire-and-forget audit log from the browser.
 * Never awaits; never throws.
 */
export function logAuditClient(entry: {
  actorEmail?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
}): void {
  try {
    // Use keepalive so the request survives page navigation (e.g. sign-out).
    fetch('/api/audit/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // swallow
  }
}
