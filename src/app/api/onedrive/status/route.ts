import { NextResponse } from 'next/server';
import { getTokens } from '@/lib/onedrive';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export async function GET() {
  const sb = await createServerSupabaseClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const tokens = await getTokens(user.email);
  if (!tokens) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: true,
    accountName: tokens.account_name,
    accountUsername: tokens.account_username,
  });
}
