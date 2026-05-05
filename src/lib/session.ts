/**
 * Cookie-based session for the standalone Microsoft Entra OAuth flow.
 *
 * Uses jose (Web-Crypto compatible) so this works in both the Node and Edge
 * runtimes — important because proxy.ts runs on the Edge runtime.
 */

import { SignJWT, jwtVerify } from 'jose';

const SESSION_COOKIE = 'um_session';
const SESSION_MAX_AGE = 60 * 60 * 8; // 8 hours

export interface SessionUser {
  email: string;
  name?: string;
  oid?: string;        // Azure AD object id
  tid?: string;        // Tenant id
  iat?: number;
}

function getSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw) throw new Error('AUTH_SECRET env var is required');
  if (raw.length < 32) throw new Error('AUTH_SECRET must be at least 32 chars');
  return new TextEncoder().encode(raw);
}

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSecret());
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (typeof payload.email !== 'string') return null;
    return {
      email: payload.email,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      oid: typeof payload.oid === 'string' ? payload.oid : undefined,
      tid: typeof payload.tid === 'string' ? payload.tid : undefined,
      iat: payload.iat,
    };
  } catch {
    return null;
  }
}

export const SESSION_CONFIG = {
  cookieName: SESSION_COOKIE,
  maxAge: SESSION_MAX_AGE,
};

/**
 * Decode an id_token's payload without verifying its signature.
 * Used right after token exchange — Microsoft already verified it before
 * issuing it. We just need the user claims to mint our session.
 *
 * Edge-runtime safe (no Buffer).
 */
export function decodeIdToken(idToken: string): {
  email?: string;
  preferred_username?: string;
  name?: string;
  oid?: string;
  tid?: string;
  upn?: string;
} | null {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    // base64url → standard base64
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}
