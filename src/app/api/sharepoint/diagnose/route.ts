import { NextRequest, NextResponse } from 'next/server';
import { getAppToken, graphFetch } from '@/lib/graph';
import { getSharePointConfig } from '@/lib/sharepoint';

export const maxDuration = 60;

/**
 * Diagnostic endpoint — walks each step of the SharePoint setup and returns
 * what succeeded vs what failed. Useful when "Run Sync" fails opaquely.
 *
 * GET /api/sharepoint/diagnose
 */
export async function GET(_request: NextRequest) {
  const out: Record<string, unknown> = { steps: [] };
  const steps = out.steps as Array<{ step: string; ok: boolean; data?: unknown; error?: string }>;

  // Step 1 — config present?
  const cfg = getSharePointConfig();
  steps.push({
    step: 'config',
    ok: !!cfg,
    data: cfg ? {
      hostname: cfg.hostname,
      sitePath: cfg.sitePath,
      rootFolder: cfg.rootFolder,
      processedFolder: cfg.processedFolder,
      hasTenantId: !!process.env.MS_TENANT_ID,
      hasClientId: !!process.env.MS_CLIENT_ID,
      hasClientSecret: !!process.env.MS_CLIENT_SECRET,
    } : 'Set SHAREPOINT_HOSTNAME, SHAREPOINT_SITE_PATH, SHAREPOINT_ROOT_FOLDER',
  });
  if (!cfg) return NextResponse.json(out);

  // Step 2 — get app token
  try {
    const token = await getAppToken();
    steps.push({ step: 'token', ok: true, data: { length: token.length, prefix: token.slice(0, 12) + '…' } });
  } catch (err) {
    steps.push({ step: 'token', ok: false, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(out);
  }

  // Step 3 — resolve site
  let siteId: string | null = null;
  try {
    const path = cfg.sitePath.startsWith('/') ? cfg.sitePath : `/${cfg.sitePath}`;
    const site = await graphFetch<{ id: string; webUrl: string; displayName?: string }>(
      `/sites/${cfg.hostname}:${path}`
    );
    siteId = site.id;
    steps.push({ step: 'site', ok: true, data: { id: site.id, webUrl: site.webUrl, displayName: site.displayName } });
  } catch (err) {
    steps.push({ step: 'site', ok: false, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(out);
  }

  // Step 4 — list permissions on the site (shows whether Sites.Selected grant landed)
  try {
    const perms = await graphFetch<{ value: Array<{ id: string; roles?: string[]; grantedToIdentitiesV2?: unknown[] }> }>(
      `/sites/${siteId}/permissions`
    );
    steps.push({
      step: 'site_permissions',
      ok: true,
      data: {
        count: perms.value.length,
        grants: perms.value.map(p => ({ id: p.id, roles: p.roles, grantedTo: p.grantedToIdentitiesV2 })),
      },
    });
  } catch (err) {
    steps.push({ step: 'site_permissions', ok: false, error: err instanceof Error ? err.message : String(err) });
  }

  // Step 5 — list drives
  try {
    const drives = await graphFetch<{ value: Array<{ id: string; name: string; driveType?: string; webUrl?: string }> }>(
      `/sites/${siteId}/drives`
    );
    steps.push({
      step: 'drives',
      ok: true,
      data: {
        count: drives.value.length,
        drives: drives.value.map(d => ({ id: d.id, name: d.name, driveType: d.driveType, webUrl: d.webUrl })),
      },
    });

    // Step 6 — try root folder lookup on default drive
    if (drives.value.length > 0) {
      const docs =
        drives.value.find(d => d.name === 'Documents') ||
        drives.value.find(d => /documents|shared/i.test(d.name)) ||
        drives.value[0];
      try {
        const root = await graphFetch<{ id: string; name: string; folder?: { childCount?: number } }>(
          `/drives/${docs.id}/root:/${encodeURI(cfg.rootFolder)}`
        );
        steps.push({ step: 'root_folder', ok: true, data: { driveName: docs.name, folderId: root.id, name: root.name, childCount: root.folder?.childCount } });
      } catch (err) {
        steps.push({ step: 'root_folder', ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    steps.push({ step: 'drives', ok: false, error: err instanceof Error ? err.message : String(err) });
  }

  return NextResponse.json(out);
}
