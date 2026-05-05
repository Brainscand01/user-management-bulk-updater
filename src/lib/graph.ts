/**
 * Microsoft Graph API helpers — application-permission flow (client credentials).
 * Used by the SharePoint sync (server-side, no user context).
 *
 * Token is cached in memory for the duration of the serverless invocation.
 */

interface TokenCache {
  token: string;
  expiresAt: number;
}

let cached: TokenCache | null = null;

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export function getGraphConfig(): GraphConfig | null {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret };
}

export async function getAppToken(): Promise<string> {
  const cfg = getGraphConfig();
  if (!cfg) throw new Error('Microsoft Graph credentials not configured (set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET).');

  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const url = `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to acquire Graph token (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
  return data.access_token;
}

/**
 * Wrapper around fetch() that adds the bearer token + JSON content-type
 * and surfaces Graph error responses cleanly.
 */
export async function graphFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await getAppToken();
  const url = path.startsWith('http')
    ? path
    : `https://graph.microsoft.com/v1.0${path.startsWith('/') ? '' : '/'}${path}`;

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...init, headers });

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (j.error?.message) detail = `${j.error.code || ''}: ${j.error.message}`;
    } catch { /* keep raw */ }
    throw new Error(`Graph ${res.status} ${path} — ${detail}`);
  }

  // Handle 204 No Content
  if (res.status === 204) return undefined as T;

  // Some endpoints return binary — let caller handle if they read .body manually
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json() as Promise<T>;
  }
  return res as unknown as T;
}

/**
 * Returns raw response so callers can stream binary (e.g. file content).
 */
export async function graphFetchRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAppToken();
  const url = path.startsWith('http')
    ? path
    : `https://graph.microsoft.com/v1.0${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers, redirect: 'follow' });
}
