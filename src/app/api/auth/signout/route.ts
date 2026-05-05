import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_CONFIG } from '@/lib/session';
import { logAudit } from '@/lib/audit';

/**
 * GET /api/auth/signout — clears our session cookie and redirects the
 * browser to Microsoft's logout endpoint, which then bounces back to /login.
 */
export async function GET(request: NextRequest) {
  const tenantId = process.env.MS_TENANT_ID;
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const origin = host ? `${proto}://${host}` : new URL(request.url).origin;

  // Audit the sign-out before clearing
  const token = request.cookies.get(SESSION_CONFIG.cookieName)?.value;
  if (token) {
    const user = await verifySession(token);
    if (user) {
      await logAudit({
        actorEmail: user.email,
        action: 'logout',
        entityType: 'user',
        entityId: user.email,
        summary: 'Signed out',
      }, request);
    }
  }

  // Microsoft logout URL bounces back to /login on our side
  const logoutUrl = tenantId
    ? `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(origin + '/login')}`
    : `${origin}/login`;

  const res = NextResponse.redirect(logoutUrl);
  res.cookies.set(SESSION_CONFIG.cookieName, '', {
    httpOnly: true,
    secure: proto === 'https',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
