import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/auth/microsoft
 * Kicks off the OAuth Authorization Code flow against the configured Entra
 * tenant + WFM application. Sets a short-lived state cookie that the
 * callback uses to defend against CSRF.
 */
export async function GET(request: NextRequest) {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  if (!tenantId || !clientId) {
    return NextResponse.json(
      { error: 'Microsoft auth not configured (MS_TENANT_ID / MS_CLIENT_ID missing)' },
      { status: 500 }
    );
  }

  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const origin = host ? `${proto}://${host}` : new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/callback`;

  // Random state for CSRF
  const state = crypto.randomUUID();

  // Optional ?next= parameter to remember where the user was heading
  const next = request.nextUrl.searchParams.get('next') || '/dashboard';

  const authorizeUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_mode', 'query');
  authorizeUrl.searchParams.set('scope', 'openid profile email User.Read offline_access');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('prompt', 'select_account');

  const res = NextResponse.redirect(authorizeUrl.toString());
  res.cookies.set('um_oauth_state', state, {
    httpOnly: true,
    secure: proto === 'https',
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 min
  });
  res.cookies.set('um_oauth_next', next, {
    httpOnly: true,
    secure: proto === 'https',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  return res;
}
