'use client';

import { Fragment, useEffect, useState, useMemo } from 'react';
import AuthGuard from '@/components/AuthGuard';
import NavHeader from '@/components/NavHeader';
import PageHeader from '@/components/PageHeader';
import { createClient } from '@/lib/supabase';

interface AuditRow {
  id: string;
  actor_email: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

function AuditContent() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actorFilter, setActorFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    load();
  }, [days]);

  async function load() {
    setLoading(true);
    const supabase = createClient();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('um_audit_log')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000);
    setRows((data as AuditRow[]) || []);
    setLoading(false);
  }

  const actions = useMemo(() => Array.from(new Set(rows.map(r => r.action))).sort(), [rows]);
  const actors = useMemo(
    () => Array.from(new Set(rows.map(r => r.actor_email).filter(Boolean))) as string[],
    [rows]
  );

  const filtered = useMemo(() => {
    let r = rows;
    if (actorFilter) r = r.filter(x => x.actor_email === actorFilter);
    if (actionFilter) r = r.filter(x => x.action === actionFilter);
    if (search) {
      const term = search.toLowerCase();
      r = r.filter(
        x =>
          (x.summary || '').toLowerCase().includes(term) ||
          (x.entity_id || '').toLowerCase().includes(term) ||
          (x.actor_email || '').toLowerCase().includes(term)
      );
    }
    return r;
  }, [rows, actorFilter, actionFilter, search]);

  function exportCSV() {
    if (filtered.length === 0) return;
    const csv = [
      'Timestamp,Actor,Action,Entity Type,Entity ID,Summary,IP',
      ...filtered.map(
        r =>
          `"${r.created_at}","${r.actor_email || ''}","${r.action}","${r.entity_type || ''}","${
            r.entity_id || ''
          }","${(r.summary || '').replace(/"/g, '""')}","${r.ip || ''}"`
      ),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_log_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const actionColor = (a: string) => {
    if (a.startsWith('login.success') || a.startsWith('batch.')) return 'bg-blue-100 text-blue-700';
    if (a.startsWith('login.failure')) return 'bg-red-100 text-red-700';
    if (a.startsWith('shift.parse')) return 'bg-purple-100 text-purple-700';
    if (a.startsWith('shift.entry.delete') || a.startsWith('shift_mapping.delete')) return 'bg-red-100 text-red-700';
    if (a.startsWith('shift.entry.edit') || a.startsWith('shift_mapping.upload')) return 'bg-amber-100 text-amber-700';
    if (a === 'logout') return 'bg-slate-100 text-slate-600';
    if (a.startsWith('template.')) return 'bg-green-100 text-green-700';
    return 'bg-slate-100 text-slate-600';
  };

  const formatDate = (s: string) =>
    new Date(s).toLocaleString('en-ZA', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  return (
    <div className="min-h-screen bg-slate-50 pl-60">
      <NavHeader />

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <PageHeader
          title="Audit Log"
          description="Every privileged action across the app: logins, sign-outs, bulk batch submissions, shift parse runs, inline edits and deletes, template downloads, and mapping uploads. Filter by actor, action, or free text."
        />

        <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-md">
              {[1, 7, 30, 90].map(d => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                    days === d ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {d === 1 ? '24h' : `${d}d`}
                </button>
              ))}
            </div>
            <select
              value={actorFilter}
              onChange={e => setActorFilter(e.target.value)}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">All actors</option>
              {actors.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <select
              value={actionFilter}
              onChange={e => setActionFilter(e.target.value)}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">All actions</option>
              {actions.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Search summary / entity id / actor..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 min-w-[200px] px-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button
              onClick={exportCSV}
              disabled={filtered.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          </div>

          <div className="text-xs text-slate-500">
            {loading ? 'Loading…' : `${filtered.length} of ${rows.length} entries`}
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">When</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Actor</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Action</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Entity</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Summary</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">IP</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <Fragment key={r.id}>
                    <tr className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600 font-mono text-xs">
                        {formatDate(r.created_at)}
                      </td>
                      <td className="px-3 py-2 text-slate-700">{r.actor_email || <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono ${actionColor(r.action)}`}>
                          {r.action}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {r.entity_type ? (
                          <span>
                            <span className="font-medium">{r.entity_type}</span>
                            {r.entity_id && <span className="opacity-60 font-mono">:{r.entity_id.slice(0, 8)}</span>}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-600 max-w-md truncate" title={r.summary || ''}>
                        {r.summary || <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 font-mono">{r.ip || '—'}</td>
                      <td className="px-3 py-2">
                        {r.metadata && (
                          <button
                            onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                            className="text-xs text-blue-600 hover:text-blue-800"
                          >
                            {expanded === r.id ? 'Hide' : 'Details'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded === r.id && r.metadata && (
                      <tr className="bg-slate-50">
                        <td colSpan={7} className="px-3 py-2">
                          <pre className="text-[11px] text-slate-700 bg-white border border-slate-200 rounded p-3 overflow-x-auto whitespace-pre-wrap">
                            {JSON.stringify(r.metadata, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {!loading && filtered.length === 0 && (
              <div className="text-sm text-slate-500 p-6 text-center">No audit entries in this range.</div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function AuditPage() {
  return (
    <AuthGuard>
      <AuditContent />
    </AuthGuard>
  );
}
