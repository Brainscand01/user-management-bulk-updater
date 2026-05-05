import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { recordProcessed } from '@/lib/onedrive';

// Record a OneDrive file as processed once parsing + finalize have succeeded.
export async function POST(request: NextRequest) {
  const sb = await createServerSupabaseClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await request.json() as {
    driveId: string;
    itemId: string;
    etag: string;
    fileName: string;
    folderPath?: string | null;
    sizeBytes?: number | null;
    lastModified?: string | null;
    parseId?: string | null;
  };

  if (!body.driveId || !body.itemId || !body.etag || !body.fileName) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  try {
    await recordProcessed({ userEmail: user.email, ...body });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to record';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
