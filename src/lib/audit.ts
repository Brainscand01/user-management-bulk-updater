import { createClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';

export interface AuditEntry {
  actorEmail?: string | null;
  action: string;                 // e.g. 'login.success', 'shift.parse', 'shift.entry.edit'
  entityType?: string | null;     // 'user' | 'shift_parse' | 'shift_entry' | 'batch' | 'template' | 'shift_mapping'
  entityId?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

export function extractRequestMeta(req: NextRequest | Request): { ip: string | null; userAgent: string | null } {
  const headers = req.headers;
  const ip =
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip') ||
    null;
  const userAgent = headers.get('user-agent') || null;
  return { ip, userAgent };
}

/**
 * Server-side audit logger. Never throws — audit failures must not break the main flow.
 */
export async function logAudit(entry: AuditEntry, req?: NextRequest | Request): Promise<void> {
  try {
    const supabase = sb();
    if (!supabase) return;

    const meta = req ? extractRequestMeta(req) : { ip: null, userAgent: null };

    await supabase.from('um_audit_log').insert({
      actor_email: entry.actorEmail || null,
      action: entry.action,
      entity_type: entry.entityType || null,
      entity_id: entry.entityId || null,
      summary: entry.summary || null,
      metadata: entry.metadata || null,
      ip: entry.ip ?? meta.ip,
      user_agent: entry.userAgent ?? meta.userAgent,
    });
  } catch {
    // swallow — audit must never break the main flow
  }
}
