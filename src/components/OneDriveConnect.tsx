'use client';

import { useCallback, useEffect, useState } from 'react';

interface DriveEntry {
  id: string;
  name: string;
  isFolder: boolean;
  isExcel: boolean;
  size: number;
  eTag: string;
  driveId: string;
  lastModified: string;
  childCount: number | null;
  alreadyProcessed: boolean;
}

interface FolderCrumb {
  id: string | null;
  name: string;
}

export interface OneDrivePulledFile {
  buffer: ArrayBuffer;
  name: string;
  driveId: string;
  itemId: string;
  eTag: string;
  size: number;
  lastModified: string;
}

interface Props {
  onFilesPulled: (files: OneDrivePulledFile[]) => void;
}

export default function OneDriveConnect({ onFilesPulled }: Props) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [crumbs, setCrumbs] = useState<FolderCrumb[]>([{ id: null, name: 'OneDrive' }]);
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string>('');
  const [banner, setBanner] = useState<string>('');

  const currentFolderId = crumbs[crumbs.length - 1].id;

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/onedrive/status');
      const data = await res.json();
      setConnected(!!data.connected);
      setAccountName(data.accountName || data.accountUsername || null);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const url = new URL(window.location.href);
    if (url.searchParams.get('onedrive_connected') === '1') {
      setBanner('OneDrive connected successfully.');
      url.searchParams.delete('onedrive_connected');
      window.history.replaceState({}, '', url.toString());
    }
    const err = url.searchParams.get('onedrive_error');
    if (err) {
      setError(`OneDrive auth error: ${err}`);
      url.searchParams.delete('onedrive_error');
      window.history.replaceState({}, '', url.toString());
    }
  }, [loadStatus]);

  const loadFolder = useCallback(async (folderId: string | null) => {
    setLoading(true);
    setError('');
    try {
      const url = folderId ? `/api/onedrive/browse?folderId=${folderId}` : '/api/onedrive/browse';
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to load folder');
        setEntries([]);
      } else {
        setEntries(data.items);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (connected) loadFolder(currentFolderId);
  }, [connected, currentFolderId, loadFolder]);

  function openFolder(entry: DriveEntry) {
    setCrumbs(prev => [...prev, { id: entry.id, name: entry.name }]);
  }

  function goToCrumb(idx: number) {
    setCrumbs(prev => prev.slice(0, idx + 1));
  }

  async function pullAllNew() {
    if (!currentFolderId && crumbs.length === 1) {
      // allow root too
    }
    setPulling(true);
    setError('');
    setBanner('');
    try {
      const url = currentFolderId
        ? `/api/onedrive/queue?folderId=${currentFolderId}`
        : '/api/onedrive/queue';
      const qRes = await fetch(url);
      const qData = await qRes.json();
      if (!qRes.ok) {
        setError(qData.error || 'Failed to list files');
        setPulling(false);
        return;
      }

      const newFiles = qData.newFiles as Array<{
        itemId: string; driveId: string; name: string; eTag: string; size: number; lastModified: string;
      }>;
      const skipped = qData.skipped as Array<{ name: string }>;

      if (newFiles.length === 0) {
        setBanner(`No new Excel files in this folder. ${skipped.length} already processed.`);
        setPulling(false);
        return;
      }

      const pulled: OneDrivePulledFile[] = [];
      for (const f of newFiles) {
        const dRes = await fetch(`/api/onedrive/download?itemId=${f.itemId}`);
        if (!dRes.ok) {
          const t = await dRes.text();
          setError(`Failed to download ${f.name}: ${t.slice(0, 200)}`);
          continue;
        }
        const buf = await dRes.arrayBuffer();
        pulled.push({
          buffer: buf,
          name: f.name,
          driveId: f.driveId,
          itemId: f.itemId,
          eTag: f.eTag,
          size: f.size,
          lastModified: f.lastModified,
        });
      }

      if (pulled.length > 0) {
        onFilesPulled(pulled);
        setBanner(
          `Queued ${pulled.length} new file${pulled.length === 1 ? '' : 's'} from OneDrive.` +
            (skipped.length ? ` Skipped ${skipped.length} already-processed file${skipped.length === 1 ? '' : 's'}.` : ''),
        );
      }

      // refresh folder to flip alreadyProcessed flags once parse finalizes
      loadFolder(currentFolderId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pull failed');
    }
    setPulling(false);
  }

  async function disconnect() {
    if (!confirm('Disconnect OneDrive? You will need to reauthorize to pull files again.')) return;
    await fetch('/api/onedrive/disconnect', { method: 'POST' });
    setConnected(false);
    setAccountName(null);
    setEntries([]);
    setCrumbs([{ id: null, name: 'OneDrive' }]);
  }

  if (connected === null) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <p className="text-sm text-slate-500">Loading OneDrive status…</p>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-slate-700">OneDrive</h2>
            <p className="text-xs text-slate-500 mt-1">
              Connect OneDrive to pull Excel files straight from a folder. Already-processed files are skipped automatically.
            </p>
          </div>
          <a
            href="/api/onedrive/connect"
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors whitespace-nowrap"
          >
            Connect OneDrive
          </a>
        </div>
        {error && <div className="mt-3 text-xs text-red-600">{error}</div>}
      </div>
    );
  }

  const newExcelCount = entries.filter(e => e.isExcel && !e.alreadyProcessed).length;
  const processedCount = entries.filter(e => e.isExcel && e.alreadyProcessed).length;

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-slate-700 flex items-center gap-2">
            OneDrive
            <span className="text-[10px] text-green-700 bg-green-50 px-1.5 py-0.5 rounded">Connected</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {accountName ? `Signed in as ${accountName}. ` : ''}
            Browse to a folder and pull new Excel files. Already-processed files are skipped.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => loadFolder(currentFolderId)}
            className="px-3 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md"
          >
            Refresh
          </button>
          <button
            onClick={disconnect}
            className="px-3 py-1.5 text-xs text-red-600 bg-red-50 hover:bg-red-100 rounded-md"
          >
            Disconnect
          </button>
        </div>
      </div>

      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 flex-wrap text-xs">
        {crumbs.map((c, i) => (
          <span key={`${c.id ?? 'root'}-${i}`} className="flex items-center gap-1">
            {i > 0 && <span className="text-slate-300">/</span>}
            <button
              onClick={() => goToCrumb(i)}
              className={i === crumbs.length - 1 ? 'text-slate-700 font-medium' : 'text-blue-600 hover:underline'}
            >
              {c.name}
            </button>
          </span>
        ))}
      </div>

      {/* Pull action */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={pullAllNew}
          disabled={pulling || newExcelCount === 0}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {pulling
            ? 'Pulling…'
            : newExcelCount === 0
              ? 'No new Excel files here'
              : `Pull ${newExcelCount} new file${newExcelCount === 1 ? '' : 's'} into queue`}
        </button>
        {processedCount > 0 && (
          <span className="text-xs text-slate-500">
            {processedCount} already processed (skipped)
          </span>
        )}
      </div>

      {banner && <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">{banner}</div>}
      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {/* Folder/file listing */}
      <div className="border border-slate-200 rounded-md overflow-hidden">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Name</th>
              <th className="px-3 py-2 text-right font-medium text-slate-600">Size</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Modified</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-slate-500">Loading…</td></tr>
            )}
            {!loading && entries.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-slate-500">Empty folder.</td></tr>
            )}
            {!loading && entries.map(e => (
              <tr key={e.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-1.5">
                  {e.isFolder ? (
                    <button onClick={() => openFolder(e)} className="text-blue-600 hover:underline flex items-center gap-1.5">
                      <span>📁</span>
                      <span className="truncate">{e.name}</span>
                    </button>
                  ) : (
                    <span className={`flex items-center gap-1.5 ${e.isExcel ? 'text-slate-700' : 'text-slate-400'}`}>
                      <span>{e.isExcel ? '📊' : '📄'}</span>
                      <span className="truncate">{e.name}</span>
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right text-slate-500 tabular-nums">
                  {e.isFolder ? '—' : formatBytes(e.size)}
                </td>
                <td className="px-3 py-1.5 text-slate-500">
                  {e.lastModified ? new Date(e.lastModified).toLocaleDateString() : '—'}
                </td>
                <td className="px-3 py-1.5">
                  {e.isFolder
                    ? <span className="text-slate-400">{e.childCount ?? 0} items</span>
                    : e.isExcel
                      ? e.alreadyProcessed
                        ? <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">Processed</span>
                        : <span className="text-[10px] text-green-700 bg-green-50 px-1.5 py-0.5 rounded">New</span>
                      : <span className="text-slate-400 text-[10px]">not xlsx</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!n) return '0';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
