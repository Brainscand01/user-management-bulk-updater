import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import {
  listChildren,
  listRootChildren,
  findAlreadyProcessed,
  normalizeEtag,
  OneDriveItem,
} from '@/lib/onedrive';

// Given a folderId (or root), list Excel files and split into "new" vs "already processed".
// The client uses the "new" list to pull files into the queue.
export async function GET(request: NextRequest) {
  const sb = await createServerSupabaseClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const folderId = searchParams.get('folderId');

  let items: OneDriveItem[];
  try {
    items = folderId ? await listChildren(user.email, folderId) : await listRootChildren(user.email);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Graph call failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const excelFiles = items.filter(i => i.file && /\.xlsx?$/i.test(i.name));
  const driveId = excelFiles[0]?.parentReference?.driveId || '';
  const processedSet = await findAlreadyProcessed(
    excelFiles.map(f => ({
      driveId: f.parentReference?.driveId || driveId,
      itemId: f.id,
      etag: f.eTag,
    })),
  );

  const newFiles: Array<{
    itemId: string;
    driveId: string;
    name: string;
    eTag: string;
    size: number;
    lastModified: string;
  }> = [];
  const skipped: Array<{ itemId: string; name: string; reason: string }> = [];

  for (const f of excelFiles) {
    const itemDrive = f.parentReference?.driveId || driveId;
    const key = `${itemDrive}::${f.id}::${normalizeEtag(f.eTag || '')}`;
    if (processedSet.has(key)) {
      skipped.push({ itemId: f.id, name: f.name, reason: 'already processed' });
    } else {
      newFiles.push({
        itemId: f.id,
        driveId: itemDrive,
        name: f.name,
        eTag: f.eTag || '',
        size: f.size,
        lastModified: f.lastModifiedDateTime,
      });
    }
  }

  return NextResponse.json({ newFiles, skipped, totalExcel: excelFiles.length });
}
