import { NextRequest, NextResponse } from 'next/server';
import { decodeIdToken, signSession, SESSION_CONFIG } from '@/lib/session';
import { logAudit } from '@/lib/audit';

/**
 * GET /api/auth/callback
 * Handles the redirect back from Microsoft. Exchanges the authorization
 * code for tokens, mints our session cookie, and redirects to the
 * originally requested page.
 */
export async function GET(request: NextRequest) {
  try {
    return await handleCallback(request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Audit best-effort, but don't let a logging failure mask the real error
    try {
      await logAudit({
        action: 'login.failure',
        summary: `Callback threw: ${msg.slice(0, 200)}`,
        metadata: { provider: 'azure', errorClass: err?.constructor?.name },
      }, request);
    } catch { /* swallow */ }
    return errorPage(`Sign-in error: ${msg}`);
  }
}

async function handleCallback(request: NextRequest) {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    return errorPage('Microsoft auth not configured (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET missing).');
  }
  if (!process.env.AUTH_SECRET) {
    return errorPage('AUTH_SECRET environment variable is missing in this deployment.');
  }
  if (process.env.AUTH_SECRET.length < 32) {
    return errorPage('AUTH_SECRET must be at least 32 characters long.');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errCode = url.searchParams.get('error');
  const errDesc = url.searchParams.get('error_description');

  if (errCode) {
    await logAudit({
      action: 'login.failure',
      summary: `OAuth error from Microsoft: ${errDesc || errCode}`,
      metadata: { provider: 'azure', error: errCode, description: errDesc },
    }, request);
    return errorPage(errDesc || errCode);
  }

  if (!code) return errorPage('Missing authorization code.');

  const cookieState = request.cookies.get('um_oauth_state')?.value;
  if (!cookieState || cookieState !== state) {
    return errorPage('State mismatch — possible CSRF. Please try signing in again.');
  }

  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const origin = host ? `${proto}://${host}` : url.origin;
  const redirectUri = `${origin}/api/auth/callback`;

  // Exchange code → tokens
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: 'openid profile email User.Read offline_access',
  });

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }
  );

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    await logAudit({
      action: 'login.failure',
      summary: `Token exchange failed: ${tokenRes.status}`,
      metadata: { provider: 'azure', status: tokenRes.status, body: text.slice(0, 500) },
    }, request);
    return errorPage(`Token exchange failed (${tokenRes.status}). Check that the redirect URI is registered on the WFM app.`);
  }

  const tokens = await tokenRes.json() as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!tokens.id_token) {
    return errorPage('No id_token returned by Microsoft.');
  }

  const claims = decodeIdToken(tokens.id_token);
  if (!claims) return errorPage('Could not decode id_token.');

  const email = claims.email || claims.preferred_username || claims.upn;
  if (!email) return errorPage('No email/upn claim in id_token.');

  const sessionToken = await signSession({
    email,
    name: claims.name,
    oid: claims.oid,
    tid: claims.tid,
  });

  const next = request.cookies.get('um_oauth_next')?.value || '/dashboard';
  const safeNext = next.startsWith('/') ? next : '/dashboard';

  const res = NextResponse.redirect(`${origin}${safeNext}`);
  res.cookies.set(SESSION_CONFIG.cookieName, sessionToken, {
    httpOnly: true,
    secure: proto === 'https',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_CONFIG.maxAge,
  });
  // Clear transient OAuth cookies
  res.cookies.delete('um_oauth_state');
  res.cookies.delete('um_oauth_next');

  await logAudit({
    actorEmail: email,
    action: 'login.success',
    entityType: 'user',
    entityId: email,
    summary: `Signed in via Microsoft SSO (${claims.name || email})`,
    metadata: { provider: 'azure', oid: claims.oid, tid: claims.tid },
  }, request);

  return res;
}

function errorPage(message: string): NextResponse {
  // Simple HTML error page so the user sees something meaningful even if
  // their JS hasn't loaded yet.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;max-width:480px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
h1{font-size:16px;margin:0 0 8px;color:#0f172a}p{color:#dc2626;background:#fef2f2;border:1px solid #fecaca;padding:12px;border-radius:6px;font-size:13px;margin:0 0 16px}
a{display:inline-block;padding:8px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-size:13px}</style>
</head><body><div class="card"><h1>Sign-in failed</h1><p>${message.replace(/[<&>]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!))}</p><a href="/login">Back to sign in</a></div></body></html>`;
  return new NextResponse(html, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
