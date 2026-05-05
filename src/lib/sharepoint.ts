/**
 * SharePoint-specific Graph operations:
 * - Resolve the configured site & drive
 * - Walk a folder recursively to find .xlsx files
 * - Download a file's binary content
 * - Move a file to the /Processed/ subfolder
 */

import { graphFetch, graphFetchRaw } from './graph';

export interface SharePointConfig {
  hostname: string;       // e.g. bizsparkmobiusco.sharepoint.com
  sitePath: string;       // e.g. /sites/CXWorkforceManagement
  rootFolder: string;     // e.g. Schedules_Combined
  processedFolder: string; // e.g. Processed
}

export function getSharePointConfig(): SharePointConfig | null {
  const hostname = process.env.SHAREPOINT_HOSTNAME;
  const sitePath = process.env.SHAREPOINT_SITE_PATH;
  const rootFolder = process.env.SHAREPOINT_ROOT_FOLDER;
  const processedFolder = process.env.SHAREPOINT_PROCESSED_FOLDER || 'Processed';
  if (!hostname || !sitePath || !rootFolder) return null;
  return { hostname, sitePath, rootFolder, processedFolder };
}

interface SiteResponse { id: string; webUrl: string; }
interface DriveResponse { id: string; name: string; }
interface DrivesListResponse { value: DriveResponse[]; }

interface DriveItem {
  id: string;
  name: string;
  eTag?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  parentReference?: { driveId?: string; path?: string };
  folder?: { childCount?: number };
  file?: { mimeType?: string };
}
interface DriveItemListResponse {
  value: DriveItem[];
  '@odata.nextLink'?: string;
}

/**
 * Resolve site id from hostname + path (e.g. /sites/CXWorkforceManagement).
 */
export async function resolveSiteId(cfg: SharePointConfig): Promise<string> {
  const path = cfg.sitePath.startsWith('/') ? cfg.sitePath : `/${cfg.sitePath}`;
  const data = await graphFetch<SiteResponse>(`/sites/${cfg.hostname}:${path}`);
  return data.id;
}

/**
 * Get the default Documents drive on the site.
 */
export async function resolveDefaultDriveId(siteId: string): Promise<string> {
  const data = await graphFetch<DrivesListResponse>(`/sites/${siteId}/drives`);
  const docs =
    data.value.find(d => d.name === 'Documents') ||
    data.value.find(d => /documents|shared/i.test(d.name)) ||
    data.value[0];
  if (!docs) throw new Error('No drives found on the SharePoint site');
  return docs.id;
}

/**
 * Get a folder driveItem by its path under the root drive.
 * Pass an empty string for the drive root.
 */
export async function getItemByPath(driveId: string, path: string): Promise<DriveItem> {
  const cleaned = path.replace(/^\/+|\/+$/g, '');
  const url = cleaned
    ? `/drives/${driveId}/root:/${encodeURI(cleaned)}`
    : `/drives/${driveId}/root`;
  return graphFetch<DriveItem>(url);
}

/**
 * Recursively list all files under a folder. Returns DriveItems for files only.
 * Yields breadth-first; capped at maxFiles to avoid runaways.
 */
export async function listFilesRecursive(
  driveId: string,
  folderItemId: string,
  options: { maxFiles?: number; relativePath?: string } = {}
): Promise<Array<DriveItem & { relativePath: string }>> {
  const maxFiles = options.maxFiles ?? 500;
  const out: Array<DriveItem & { relativePath: string }> = [];
  const queue: Array<{ id: string; relPath: string }> = [
    { id: folderItemId, relPath: options.relativePath || '' },
  ];

  while (queue.length > 0 && out.length < maxFiles) {
    const node = queue.shift()!;
    let next: string | undefined =
      `/drives/${driveId}/items/${node.id}/children?$top=200&$select=id,name,eTag,size,webUrl,lastModifiedDateTime,folder,file,parentReference`;

    while (next && out.length < maxFiles) {
      const data: DriveItemListResponse = await graphFetch(next);
      for (const item of data.value) {
        const childPath = node.relPath ? `${node.relPath}/${item.name}` : item.name;
        if (item.folder) {
          queue.push({ id: item.id, relPath: childPath });
        } else if (item.file) {
          out.push({ ...item, relativePath: childPath });
          if (out.length >= maxFiles) break;
        }
      }
      next = data['@odata.nextLink'];
    }
  }
  return out;
}

/**
 * Download a file's content as ArrayBuffer.
 * Graph returns a 302 redirect to the binary; graphFetchRaw follows redirects.
 */
export async function downloadFile(driveId: string, itemId: string): Promise<ArrayBuffer> {
  const res = await graphFetchRaw(`/drives/${driveId}/items/${itemId}/content`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Download failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.arrayBuffer();
}

/**
 * Ensure the /Processed/ folder exists at the root of `rootFolder`.
 * Returns the processed folder's driveItem id.
 */
export async function ensureProcessedFolder(
  driveId: string,
  rootFolderPath: string,
  processedName: string
): Promise<string> {
  const fullPath = `${rootFolderPath.replace(/^\/+|\/+$/g, '')}/${processedName}`;
  try {
    const item = await getItemByPath(driveId, fullPath);
    if (item.folder) return item.id;
  } catch { /* not found — fall through to create */ }

  // Create under rootFolderPath
  const parent = await getItemByPath(driveId, rootFolderPath);
  const created = await graphFetch<DriveItem>(
    `/drives/${driveId}/items/${parent.id}/children`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: processedName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    }
  );
  return created.id;
}

/**
 * Move a file to a target folder by id.
 */
export async function moveItem(driveId: string, itemId: string, targetFolderId: string): Promise<void> {
  await graphFetch(`/drives/${driveId}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      parentReference: { id: targetFolderId },
    }),
  });
}

export type SharePointFile = DriveItem & { relativePath: string };
