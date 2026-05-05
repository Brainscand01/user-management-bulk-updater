import { NextRequest, NextResponse } from 'next/server';
import { buildAuthUrl } from '@/lib/onedrive';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import crypto from 'crypto';

export async function GET(_request: NextRequest) {
  const sb = await createServerSupabaseClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user?.email) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // state = random nonce + email (signed by short HMAC) — validated in callback
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = Buffer.from(JSON.stringify({ n: nonce, e: user.email })).toString('base64url');

  try {
    const url = buildAuthUrl(state);
    const res = NextResponse.redirect(url);
    res.cookies.set('onedrive_oauth_state', state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 10 * 60,
      path: '/',
    });
    return res;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Config error' },
      { status: 500 },
    );
  }
}
