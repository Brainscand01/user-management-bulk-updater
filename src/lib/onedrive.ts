// Microsoft Graph + OneDrive helper — no SDK, plain fetch.
// Token storage goes through um_onedrive_tokens; this module only knows how to
// talk to Graph once it has an access token.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const AUTH_HOST = 'https://login.microsoftonline.com';

export const SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'User.Read',
  'Files.Read',
  'Files.Read.All',
].join(' ');

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_name: string | null;
  account_username: string | null;
}

export interface OneDriveItem {
  id: string;
  name: string;
  eTag: string;
  size: number;
  folder?: { childCount: number };
  file?: { mimeType: string };
  lastModifiedDateTime: string;
  parentReference?: { driveId: string; path?: string };
  '@microsoft.graph.downloadUrl'?: string;
}

// ---------- Supabase service client (server-only) ----------

function service(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

// ---------- OAuth ----------

export function getAzureConfig() {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const redirectUri =
    process.env.MS_REDIRECT_URI ||
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}/api/onedrive/callback`
      : 'http://localhost:3000/api/onedrive/callback');
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Microsoft Azure env vars missing (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET)');
  }
  return { tenantId, clientId, clientSecret, redirectUri };
}

export function buildAuthUrl(state: string): string {
  const { tenantId, clientId, redirectUri } = getAzureConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
    prompt: 'select_account',
  });
  return `${AUTH_HOST}/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
}

async function exchangeToken(body: Record<string, string>): Promise<TokenResponse> {
  const { tenantId } = getAzureConfig();
  const res = await fetch(`${AUTH_HOST}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Microsoft token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as TokenResponse;
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const { clientId, clientSecret, redirectUri } = getAzureConfig();
  return exchangeToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: SCOPES,
  });
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = getAzureConfig();
  return exchangeToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES,
  });
}

function decodeIdToken(idToken?: string): { name?: string; preferred_username?: string; email?: string } {
  if (!idToken) return {};
  try {
    const payload = idToken.split('.')[1];
    const json = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export async function saveTokens(userEmail: string, tok: TokenResponse) {
  const sb = service();
  const claims = decodeIdToken(tok.id_token);
  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();
  const { error } = await sb.from('um_onedrive_tokens').upsert({
    user_email: userEmail,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: expiresAt,
    account_name: claims.name ?? null,
    account_username: claims.preferred_username ?? claims.email ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Failed to save OneDrive tokens: ${error.message}`);
}

export async function getTokens(userEmail: string): Promise<StoredTokens | null> {
  const sb = service();
  const { data, error } = await sb
    .from('um_onedrive_tokens')
    .select('access_token, refresh_token, expires_at, account_name, account_username')
    .eq('user_email', userEmail)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function clearTokens(userEmail: string) {
  const sb = service();
  await sb.from('um_onedrive_tokens').delete().eq('user_email', userEmail);
}

async function getFreshAccessToken(userEmail: string): Promise<string> {
  const stored = await getTokens(userEmail);
  if (!stored) throw new Error('OneDrive not connected');
  if (new Date(stored.expires_at).getTime() > Date.now()) return stored.access_token;
  const refreshed = await refreshTokens(stored.refresh_token);
  await saveTokens(userEmail, refreshed);
  return refreshed.access_token;
}

// ---------- Graph calls ----------

async function graph<T>(userEmail: string, path: string): Promise<T> {
  const token = await getFreshAccessToken(userEmail);
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Graph ${res.status} ${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export async function listRootChildren(userEmail: string): Promise<OneDriveItem[]> {
  const data = await graph<{ value: OneDriveItem[] }>(userEmail, `/me/drive/root/children?$top=200`);
  return data.value;
}

export async function listChildren(userEmail: string, itemId: string): Promise<OneDriveItem[]> {
  const data = await graph<{ value: OneDriveItem[] }>(userEmail, `/me/drive/items/${itemId}/children?$top=200`);
  return data.value;
}

export async function getItem(userEmail: string, itemId: string): Promise<OneDriveItem> {
  return graph<OneDriveItem>(userEmail, `/me/drive/items/${itemId}`);
}

export async function downloadFile(userEmail: string, itemId: string): Promise<ArrayBuffer> {
  const token = await getFreshAccessToken(userEmail);
  const res = await fetch(`${GRAPH}/me/drive/items/${itemId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for item ${itemId}`);
  return res.arrayBuffer();
}

// ---------- Dedup ----------

export function normalizeEtag(etag: string): string {
  return etag.replace(/"/g, '').trim();
}

export async function findAlreadyProcessed(
  driveItemEtags: { driveId: string; itemId: string; etag: string }[],
): Promise<Set<string>> {
  if (driveItemEtags.length === 0) return new Set();
  const sb = service();
  const keys = driveItemEtags.map(x => `${x.driveId}::${x.itemId}::${normalizeEtag(x.etag)}`);
  const { data, error } = await sb
    .from('um_onedrive_processed_files')
    .select('drive_id, item_id, etag')
    .in('item_id', driveItemEtags.map(x => x.itemId));
  if (error) throw new Error(error.message);
  const seen = new Set<string>();
  for (const row of data || []) {
    seen.add(`${row.drive_id}::${row.item_id}::${normalizeEtag(row.etag)}`);
  }
  return new Set(keys.filter(k => seen.has(k)));
}

export async function recordProcessed(params: {
  userEmail: string;
  driveId: string;
  itemId: string;
  etag: string;
  fileName: string;
  folderPath?: string | null;
  sizeBytes?: number | null;
  lastModified?: string | null;
  parseId?: string | null;
}) {
  const sb = service();
  const { error } = await sb.from('um_onedrive_processed_files').upsert(
    {
      user_email: params.userEmail,
      drive_id: params.driveId,
      item_id: params.itemId,
      etag: normalizeEtag(params.etag),
      file_name: params.fileName,
      folder_path: params.folderPath ?? null,
      size_bytes: params.sizeBytes ?? null,
      last_modified: params.lastModified ?? null,
      parse_id: params.parseId ?? null,
    },
    { onConflict: 'drive_id,item_id,etag' },
  );
  if (error) throw new Error(`Failed to record processed file: ${error.message}`);
}
