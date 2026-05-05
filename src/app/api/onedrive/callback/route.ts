import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens, saveTokens } from '@/lib/onedrive';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const err = searchParams.get('error_description') || searchParams.get('error');

  if (err) {
    return redirectBack(request, `onedrive_error=${encodeURIComponent(err)}`);
  }
  if (!code || !state) {
    return redirectBack(request, 'onedrive_error=missing_code_or_state');
  }

  const cookieState = request.cookies.get('onedrive_oauth_state')?.value;
  if (!cookieState || cookieState !== state) {
    return redirectBack(request, 'onedrive_error=state_mismatch');
  }

  let userEmail: string;
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { e: string };
    userEmail = parsed.e;
  } catch {
    return redirectBack(request, 'onedrive_error=bad_state');
  }

  try {
    const tok = await exchangeCodeForTokens(code);
    await saveTokens(userEmail, tok);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'token exchange failed';
    return redirectBack(request, `onedrive_error=${encodeURIComponent(msg)}`);
  }

  const res = redirectBack(request, 'onedrive_connected=1');
  res.cookies.delete('onedrive_oauth_state');
  return res;
}

function redirectBack(request: NextRequest, query: string) {
  const base = new URL('/dashboard/shifts', request.url);
  base.search = query;
  return NextResponse.redirect(base);
}
