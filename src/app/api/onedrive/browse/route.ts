import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import {
  listRootChildren,
  listChildren,
  findAlreadyProcessed,
  normalizeEtag,
  OneDriveItem,
} from '@/lib/onedrive';

// List children of a folder (or root). Flag each file as already-processed so
// the UI can show that and skip on pull.
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

  const files = items.filter(i => i.file);
  const excelFiles = files.filter(i => /\.xlsx?$/i.test(i.name));
  const driveId = items[0]?.parentReference?.driveId || '';
  const processedSet = await findAlreadyProcessed(
    excelFiles.map(f => ({
      driveId: f.parentReference?.driveId || driveId,
      itemId: f.id,
      etag: f.eTag,
    })),
  );

  const out = items.map(i => {
    const itemDrive = i.parentReference?.driveId || driveId;
    const key = `${itemDrive}::${i.id}::${normalizeEtag(i.eTag || '')}`;
    const isExcel = !!i.file && /\.xlsx?$/i.test(i.name);
    return {
      id: i.id,
      name: i.name,
      isFolder: !!i.folder,
      isExcel,
      size: i.size,
      eTag: i.eTag,
      driveId: itemDrive,
      lastModified: i.lastModifiedDateTime,
      childCount: i.folder?.childCount ?? null,
      alreadyProcessed: isExcel && processedSet.has(key),
    };
  });

  return NextResponse.json({ items: out });
}
