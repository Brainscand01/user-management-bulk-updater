'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import AuthGuard, { useCurrentUser } from '@/components/AuthGuard';
import NavHeader from '@/components/NavHeader';
import PageHeader from '@/components/PageHeader';
import { createClient } from '@/lib/supabase';
import Link from 'next/link';

interface SharePointFile {
  id: string;
  graph_file_id: string;
  name: string;
  folder_path: string | null;
  size_bytes: number | null;
  last_modified_at: string | null;
  status: 'discovered' | 'parsing' | 'parsed' | 'failed' | 'moved' | 'submitted';
  parse_id: string | null;
  error_message: string | null;
  discovered_at: string;
  parsed_at: string | null;
  moved_at: string | null;
  submitted_at: string | null;
}

type StatusFilter = 'all' | 'pending' | 'parsed' | 'failed' | 'done';

function SharePointContent() {
  const user = useCurrentUser();
  const [files, setFiles] = useState<SharePointFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('um_sharepoint_files')
      .select('*')
      .order('discovered_at', { ascending: false })
      .limit(500);
    setFiles((data as SharePointFile[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let rows = files;
    if (filter === 'pending') rows = rows.filter(f => f.status === 'discovered' || f.status === 'parsing');
    else if (filter === 'parsed') rows = rows.filter(f => f.status === 'parsed');
    else if (filter === 'failed') rows = rows.filter(f => f.status === 'failed');
    else if (filter === 'done') rows = rows.filter(f => f.status === 'moved' || f.status === 'submitted');
    if (search) {
      const t = search.toLowerCase();
      rows = rows.filter(f =>
        f.name.toLowerCase().includes(t) ||
        (f.folder_path || '').toLowerCase().includes(t)
      );
    }
    return rows;
  }, [files, filter, search]);

  const counts = useMemo(() => ({
    total: files.length,
    pending: files.filter(f => f.status === 'discovered' || f.status === 'parsing').length,
    parsed: files.filter(f => f.status === 'parsed').length,
    failed: files.filter(f => f.status === 'failed').length,
    done: files.filter(f => f.status === 'moved' || f.status === 'submitted').length,
  }), [files]);

  function setBusy(id: string, on: boolean) {
    setBusyIds(prev => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  async function runSync() {
    setSyncing(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch('/api/sharepoint/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorEmail: user?.email || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Sync failed');
      } else {
        setInfo(`Sync complete: scanned ${data.scanned} files, ${data.newlyDiscovered} new, ${data.alreadyKnown} already known`);
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    }
    setSyncing(false);
  }

  async function processFile(id: string) {
    setBusy(id, true);
    setError(null);
    try {
      const res = await fetch(`/api/sharepoint/files/${id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorEmail: user?.email || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(`Parse failed: ${data.error || 'unknown'}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parse failed');
    }
    setBusy(id, false);
  }

  async function moveFile(id: string) {
    setBusy(id, true);
    setError(null);
    try {
      const res = await fetch(`/api/sharepoint/files/${id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorEmail: user?.email || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(`Move failed: ${data.error || 'unknown'}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Move failed');
    }
    setBusy(id, false);
  }

  async function processAllPending() {
    const pending = files.filter(f => f.status === 'discovered');
    if (pending.length === 0) return;
    if (!confirm(`Parse ${pending.length} pending file(s)? This will run them sequentially via Claude Haiku.`)) return;
    for (const f of pending) {
      // Refresh row from server before processing in case state has shifted
      await processFile(f.id);
    }
  }

  const statusBadge = (s: SharePointFile['status']) => {
    const map: Record<typeof s, string> = {
      discovered: 'bg-blue-100 text-blue-700',
      parsing: 'bg-amber-100 text-amber-700 animate-pulse',
      parsed: 'bg-green-100 text-green-700',
      failed: 'bg-red-100 text-red-700',
      moved: 'bg-slate-100 text-slate-600',
      submitted: 'bg-purple-100 text-purple-700',
    };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${map[s]}`}>
        {s}
      </span>
    );
  };

  const formatDate = (s: string | null) =>
    s ? new Date(s).toLocaleString('en-ZA', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  const formatSize = (b: number | null) => {
    if (!b) return '—';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  };

  return (
    <div className="min-h-screen bg-slate-50 pl-60">
      <NavHeader />

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <PageHeader
          title="SharePoint Sync"
          description="Pull workforce planner files from the CXWorkforceManagement SharePoint site, parse them with AI, review the output, and (after human cross-check) push the resulting shift assignments back to Portelo. Click 'Run Sync Now' to discover new files; click 'Parse' on a file to send it through Claude. Source files move to /Processed/ when you're done."
        />

        {/* Top controls */}
        <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={runSync}
                disabled={syncing}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {syncing ? (
                  <>
                    <span className="inline-block animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    Scanning…
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Run Sync Now
                  </>
                )}
              </button>
              <button
                onClick={processAllPending}
                disabled={syncing || counts.pending === 0}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200 disabled:opacity-50 transition-colors"
              >
                Parse All Pending ({counts.pending})
              </button>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Search filename or folder..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-60"
              />
            </div>
          </div>

          {/* Stats pills */}
          <div className="flex flex-wrap gap-2 text-xs">
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1 rounded-full border ${filter === 'all' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'}`}
            >
              All ({counts.total})
            </button>
            <button
              onClick={() => setFilter('pending')}
              className={`px-3 py-1 rounded-full border ${filter === 'pending' ? 'bg-blue-600 text-white border-blue-600' : 'bg-blue-50 text-blue-700 border-blue-200'}`}
            >
              Pending ({counts.pending})
            </button>
            <button
              onClick={() => setFilter('parsed')}
              className={`px-3 py-1 rounded-full border ${filter === 'parsed' ? 'bg-green-600 text-white border-green-600' : 'bg-green-50 text-green-700 border-green-200'}`}
            >
              Parsed ({counts.parsed})
            </button>
            <button
              onClick={() => setFilter('failed')}
              className={`px-3 py-1 rounded-full border ${filter === 'failed' ? 'bg-red-600 text-white border-red-600' : 'bg-red-50 text-red-700 border-red-200'}`}
            >
              Failed ({counts.failed})
            </button>
            <button
              onClick={() => setFilter('done')}
              className={`px-3 py-1 rounded-full border ${filter === 'done' ? 'bg-slate-700 text-white border-slate-700' : 'bg-slate-50 text-slate-600 border-slate-200'}`}
            >
              Moved/Done ({counts.done})
            </button>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">{error}</div>
          )}
          {info && (
            <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-700">{info}</div>
          )}
        </div>

        {/* Files table */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          {loading ? (
            <div className="text-sm text-slate-500">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10 text-sm text-slate-500">
              {files.length === 0 ? (
                <>No files yet. Click <strong>Run Sync Now</strong> to scan SharePoint.</>
              ) : (
                <>No files match this filter.</>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">File</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Folder</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Size</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Modified</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Parsed</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(f => {
                    const busy = busyIds.has(f.id);
                    return (
                      <tr key={f.id} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-3 py-2">{statusBadge(f.status)}</td>
                        <td className="px-3 py-2 font-medium text-slate-900 max-w-[260px] truncate" title={f.name}>
                          {f.name}
                          {f.error_message && (
                            <div className="text-[10px] text-red-600 mt-0.5 truncate" title={f.error_message}>
                              {f.error_message}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500 max-w-[220px] truncate" title={f.folder_path || ''}>
                          {f.folder_path || '—'}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500">{formatSize(f.size_bytes)}</td>
                        <td className="px-3 py-2 text-xs text-slate-500">{formatDate(f.last_modified_at)}</td>
                        <td className="px-3 py-2 text-xs text-slate-500">{formatDate(f.parsed_at)}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2 justify-end">
                            {f.status === 'discovered' && (
                              <button
                                onClick={() => processFile(f.id)}
                                disabled={busy}
                                className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
                              >
                                {busy ? 'Parsing…' : 'Parse'}
                              </button>
                            )}
                            {f.status === 'failed' && (
                              <button
                                onClick={() => processFile(f.id)}
                                disabled={busy}
                                className="px-2.5 py-1 text-xs font-medium text-white bg-amber-600 rounded hover:bg-amber-700 disabled:opacity-50"
                              >
                                {busy ? 'Retrying…' : 'Retry'}
                              </button>
                            )}
                            {(f.status === 'parsed' || f.status === 'submitted') && f.parse_id && (
                              <Link
                                href={`/dashboard/shifts/history?parse=${f.parse_id}`}
                                className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded hover:bg-blue-100"
                              >
                                Review
                              </Link>
                            )}
                            {(f.status === 'parsed' || f.status === 'submitted') && (
                              <button
                                onClick={() => moveFile(f.id)}
                                disabled={busy}
                                className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-50"
                              >
                                {busy ? 'Moving…' : 'Move to /Processed/'}
                              </button>
                            )}
                            <button
                              disabled
                              title="Coming soon — pushes parsed shifts to Portelo via bulk update"
                              className="px-2.5 py-1 text-xs font-medium text-slate-400 bg-slate-50 rounded cursor-not-allowed"
                            >
                              Submit to Portelo
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function SharePointPage() {
  return (
    <AuthGuard>
      <SharePointContent />
    </AuthGuard>
  );
}
