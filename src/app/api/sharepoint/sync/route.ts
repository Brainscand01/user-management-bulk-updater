import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import {
  getSharePointConfig,
  resolveSiteId,
  resolveDefaultDriveId,
  getItemByPath,
  listFilesRecursive,
} from '@/lib/sharepoint';

// Discovery only — fast walk, no AI work. Vercel Pro default 60s is plenty.
export const maxDuration = 60;

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * POST /api/sharepoint/sync
 *
 * Walks the configured SharePoint root folder recursively, finds all .xlsx
 * files, and inserts any not yet known into um_sharepoint_files. Existing
 * files (matched on graph_file_id + etag) are skipped — re-uploaded files
 * with a new etag get re-discovered for re-processing.
 *
 * The Processed/ subfolder is excluded from discovery.
 */
export async function POST(request: NextRequest) {
  try {
    const cfg = getSharePointConfig();
    if (!cfg) {
      return NextResponse.json(
        { error: 'SharePoint not configured. Set SHAREPOINT_HOSTNAME, SHAREPOINT_SITE_PATH, SHAREPOINT_ROOT_FOLDER in Vercel.' },
        { status: 500 }
      );
    }

    const supabase = sb();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const body = await request.json().catch(() => ({})) as { actorEmail?: string };
    const actorEmail = body.actorEmail || null;

    // Resolve site → drive → root folder
    const siteId = await resolveSiteId(cfg);
    const driveId = await resolveDefaultDriveId(siteId);
    const rootItem = await getItemByPath(driveId, cfg.rootFolder);

    // Walk recursively (skip Processed subfolder by name in post-filter)
    const allFiles = await listFilesRecursive(driveId, rootItem.id, {
      maxFiles: 1000,
      relativePath: cfg.rootFolder,
    });

    const xlsxFiles = allFiles.filter(f => {
      const name = f.name.toLowerCase();
      if (!name.endsWith('.xlsx') && !name.endsWith('.xlsm')) return false;
      // Skip anything inside the processed folder
      const processedSegment = `/${cfg.processedFolder}/`.toLowerCase();
      if ((`/${f.relativePath.toLowerCase()}/`).includes(processedSegment)) return false;
      // Skip Excel temp/lock files
      if (name.startsWith('~$')) return false;
      return true;
    });

    // Existing rows by (graph_file_id, etag)
    const fileIds = xlsxFiles.map(f => f.id);
    let existing: Array<{ graph_file_id: string; etag: string | null }> = [];
    if (fileIds.length > 0) {
      const { data } = await supabase
        .from('um_sharepoint_files')
        .select('graph_file_id, etag')
        .in('graph_file_id', fileIds);
      existing = data || [];
    }
    const existingKey = new Set(existing.map(e => `${e.graph_file_id}::${e.etag || ''}`));

    const toInsert = xlsxFiles.filter(f => !existingKey.has(`${f.id}::${f.eTag || ''}`));

    let inserted = 0;
    if (toInsert.length > 0) {
      const rows = toInsert.map(f => ({
        graph_file_id: f.id,
        drive_id: driveId,
        etag: f.eTag || null,
        name: f.name,
        folder_path: f.relativePath.replace(new RegExp(`/${f.name}$`), ''),
        size_bytes: f.size || null,
        last_modified_at: f.lastModifiedDateTime || null,
        status: 'discovered',
      }));
      const { error } = await supabase.from('um_sharepoint_files').upsert(rows, {
        onConflict: 'graph_file_id,etag',
        ignoreDuplicates: true,
      });
      if (error) {
        return NextResponse.json({ error: `Insert failed: ${error.message}` }, { status: 500 });
      }
      inserted = rows.length;
    }

    await logAudit({
      actorEmail,
      action: 'sharepoint.sync',
      entityType: 'sharepoint',
      summary: `SharePoint sync: scanned ${xlsxFiles.length} .xlsx files, ${inserted} newly discovered`,
      metadata: {
        rootFolder: cfg.rootFolder,
        scanned: xlsxFiles.length,
        newlyDiscovered: inserted,
        alreadyKnown: xlsxFiles.length - inserted,
      },
    }, request);

    return NextResponse.json({
      scanned: xlsxFiles.length,
      newlyDiscovered: inserted,
      alreadyKnown: xlsxFiles.length - inserted,
      siteId,
      driveId,
      rootFolder: cfg.rootFolder,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
