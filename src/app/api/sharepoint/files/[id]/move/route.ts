import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import {
  getSharePointConfig,
  resolveSiteId,
  resolveDefaultDriveId,
  ensureProcessedFolder,
  moveItem,
} from '@/lib/sharepoint';

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * POST /api/sharepoint/files/[id]/move
 * Moves the source file to /<rootFolder>/<processedFolder>/ and marks
 * the row as moved. Safe to call after parsing or after Portelo submit.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const cfg = getSharePointConfig();
    if (!cfg) {
      return NextResponse.json({ error: 'SharePoint not configured' }, { status: 500 });
    }
    const supabase = sb();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const body = await request.json().catch(() => ({})) as { actorEmail?: string };
    const actorEmail = body.actorEmail || null;

    const { data: row } = await supabase
      .from('um_sharepoint_files')
      .select('*')
      .eq('id', id)
      .single();

    if (!row) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if (row.status === 'moved') {
      return NextResponse.json({ ok: true, alreadyMoved: true });
    }

    const siteId = await resolveSiteId(cfg);
    const driveId = await resolveDefaultDriveId(siteId);
    const processedFolderId = await ensureProcessedFolder(driveId, cfg.rootFolder, cfg.processedFolder);
    await moveItem(driveId, row.graph_file_id, processedFolderId);

    await supabase
      .from('um_sharepoint_files')
      .update({ status: 'moved', moved_at: new Date().toISOString() })
      .eq('id', id);

    await logAudit({
      actorEmail,
      action: 'sharepoint.file.moved',
      entityType: 'sharepoint',
      entityId: id,
      summary: `Moved ${row.name} to /${cfg.processedFolder}/`,
      metadata: { fileName: row.name, processedFolder: cfg.processedFolder },
    }, request);

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
