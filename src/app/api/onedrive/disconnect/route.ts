import { NextResponse } from 'next/server';
import { clearTokens } from '@/lib/onedrive';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export async function POST() {
  const sb = await createServerSupabaseClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  await clearTokens(user.email);
  return NextResponse.json({ ok: true });
}
