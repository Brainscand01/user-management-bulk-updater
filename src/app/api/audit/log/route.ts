import { NextRequest, NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';

/**
 * Client-side audit entry point. Used for browser-only events like
 * template downloads, logins (success & failure), and navigation events.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      actorEmail?: string | null;
      action: string;
      entityType?: string | null;
      entityId?: string | null;
      summary?: string | null;
      metadata?: Record<string, unknown> | null;
    };

    if (!body.action || typeof body.action !== 'string') {
      return NextResponse.json({ error: 'action is required' }, { status: 400 });
    }

    await logAudit(body, request);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
