import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_CONFIG } from '@/lib/session';

/**
 * GET /api/auth/session
 * Returns the current user from the session cookie, or { user: null }.
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_CONFIG.cookieName)?.value;
  if (!token) return NextResponse.json({ user: null });
  const user = await verifySession(token);
  return NextResponse.json({ user });
}
