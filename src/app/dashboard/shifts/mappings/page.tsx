'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import AuthGuard, { useCurrentUser } from '@/components/AuthGuard';
import NavHeader from '@/components/NavHeader';
import PageHeader from '@/components/PageHeader';
import { createClient } from '@/lib/supabase';

interface Mapping {
  id: string;
  shift_id: string;
  label: string;
  start_time: string | null;
  end_time: string | null;
  campaign: string | null;
  active: boolean;
  notes: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface IncomingRow {
  shift_id: string;
  start_time: string;
  end_time: string;
  label?: string;
  campaign?: string;
  notes?: string;
  active?: boolean;
}

type Diff = {
  row: IncomingRow;
  state: 'new' | 'changed' | 'unchanged';
  before?: Mapping;
};

function parseCSV(text: string): IncomingRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const idxOf = (name: string) => header.findIndex(h => h === name.toLowerCase());
  const shiftIdx = idxOf('shift_id');
  const startIdx = idxOf('start_time');
  const endIdx = idxOf('end_time');
  const labelIdx = idxOf('label');
  const campaignIdx = idxOf('campaign');
  const notesIdx = idxOf('notes');

  if (shiftIdx === -1 || startIdx === -1 || endIdx === -1) {
    throw new Error('CSV must include columns: SHIFT_ID, START_TIME, END_TIME');
  }

  return lines.slice(1).map(line => {
    const cells = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    return {
      shift_id: cells[shiftIdx] || '',
      start_time: cells[startIdx] || '',
      end_time: cells[endIdx] || '',
      label: labelIdx >= 0 ? cells[labelIdx] : undefined,
      campaign: campaignIdx >= 0 ? cells[campaignIdx] : undefined,
      notes: notesIdx >= 0 ? cells[notesIdx] : undefined,
    };
  }).filter(r => r.shift_id);
}

function MappingsContent() {
  const user = useCurrentUser();
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [pending, setPending] = useState<IncomingRow[] | null>(null);
  const [pendingFileName, setPendingFileName] = useState('');
  const [deactivateMissing, setDeactivateMissing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('um_shift_mappings')
      .select('*')
      .order('start_time', { ascending: true });
    setMappings((data as Mapping[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let rows = mappings;
    if (!showInactive) rows = rows.filter(m => m.active);
    if (search) {
      const t = search.toLowerCase();
      rows = rows.filter(m =>
        m.shift_id.toLowerCase().includes(t) ||
        m.label.toLowerCase().includes(t) ||
        (m.campaign || '').toLowerCase().includes(t)
      );
    }
    return rows;
  }, [mappings, showInactive, search]);

  const mappingByShiftId = useMemo(() => {
    const m = new Map<string, Mapping>();
    for (const r of mappings) m.set(r.shift_id, r);
    return m;
  }, [mappings]);

  const diff: Diff[] = useMemo(() => {
    if (!pending) return [];
    return pending.map(row => {
      const before = mappingByShiftId.get(row.shift_id);
      if (!before) return { row, state: 'new' as const };
      const newLabel = row.label || (row.start_time && row.end_time ? `${row.start_time} - ${row.end_time}` : row.shift_id);
      const changed =
        before.start_time !== (row.start_time || null) ||
        before.end_time !== (row.end_time || null) ||
        before.label !== newLabel;
      return { row, state: changed ? 'changed' as const : 'unchanged' as const, before };
    });
  }, [pending, mappingByShiftId]);

  const diffCounts = useMemo(() => ({
    total: diff.length,
    newRows: diff.filter(d => d.state === 'new').length,
    changed: diff.filter(d => d.state === 'changed').length,
    unchanged: diff.filter(d => d.state === 'unchanged').length,
  }), [diff]);

  const willDeactivateCount = useMemo(() => {
    if (!pending || !deactivateMissing) return 0;
    const incoming = new Set(pending.map(p => p.shift_id));
    return mappings.filter(m => m.active && !incoming.has(m.shift_id)).length;
  }, [pending, deactivateMissing, mappings]);

  async function handleFile(file: File) {
    setError(null);
    setResult(null);
    setPendingFileName(file.name);
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (rows.length === 0) {
        setError('No valid rows found in CSV');
        return;
      }
      setPending(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse CSV');
    }
  }

  async function apply() {
    if (!pending) return;
    setApplying(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/shifts/mappings/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: pending,
          actorEmail: user?.email || null,
          deactivateMissing,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Upload failed');
      } else {
        setResult(`Applied: +${data.inserted} new, ~${data.updated} changed, ${data.unchanged} unchanged${data.deactivated ? `, ${data.deactivated} deactivated` : ''}.`);
        setPending(null);
        setPendingFileName('');
        setDeactivateMissing(false);
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    }
    setApplying(false);
  }

  function cancel() {
    setPending(null);
    setPendingFileName('');
    setDeactivateMissing(false);
    setError(null);
  }

  function exportCSV() {
    const header = 'SHIFT_ID,START_TIME,END_TIME,LABEL,CAMPAIGN,ACTIVE,NOTES';
    const rows = mappings.map(m =>
      `"${m.shift_id}","${m.start_time || ''}","${m.end_time || ''}","${m.label}","${m.campaign || ''}",${m.active ? 1 : 0},"${(m.notes || '').replace(/"/g, '""')}"`
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shift_mappings_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-slate-50 pl-60">
      <NavHeader />

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <PageHeader
          title="Shift Mappings"
          description="Master list mapping Portelo Shift IDs to time ranges. Used when submitting Shift Updates — the parser matches agent shift times against this table to find the correct Shift ID. Upload a CSV to add or update entries; re-upload the file any time the master list changes."
        />

        {/* Upload card */}
        <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium text-slate-700">Upload / Update via CSV</h2>
              <p className="text-xs text-slate-500 mt-1">
                Required columns: <code className="text-[11px] bg-slate-100 px-1 rounded">SHIFT_ID</code>, <code className="text-[11px] bg-slate-100 px-1 rounded">START_TIME</code>, <code className="text-[11px] bg-slate-100 px-1 rounded">END_TIME</code>.
                Optional: <code className="text-[11px] bg-slate-100 px-1 rounded">LABEL</code>, <code className="text-[11px] bg-slate-100 px-1 rounded">CAMPAIGN</code>, <code className="text-[11px] bg-slate-100 px-1 rounded">NOTES</code>.
                Upsert is keyed on <code className="text-[11px] bg-slate-100 px-1 rounded">SHIFT_ID</code> — safe to re-upload.
              </p>
            </div>
            <button
              onClick={exportCSV}
              disabled={mappings.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-md hover:bg-slate-200 transition-colors disabled:opacity-50"
            >
              Download current as CSV
            </button>
          </div>

          {!pending && (
            <label className="flex items-center justify-center gap-3 p-6 border-2 border-dashed border-slate-300 rounded-lg hover:border-blue-400 hover:bg-blue-50/40 transition-colors cursor-pointer">
              <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <span className="text-sm text-slate-600">Click to choose a CSV file</span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = '';
                }}
              />
            </label>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {result && (
            <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm text-green-700">
              {result}
            </div>
          )}

          {pending && (
            <div className="space-y-3">
              <div className="text-xs text-slate-500">
                <span className="font-medium text-slate-700">{pendingFileName}</span> — {diffCounts.total} rows
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                  +{diffCounts.newRows} new
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                  ~{diffCounts.changed} changed
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                  {diffCounts.unchanged} unchanged
                </span>
                {deactivateMissing && willDeactivateCount > 0 && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                    {willDeactivateCount} will be deactivated
                  </span>
                )}
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={deactivateMissing}
                  onChange={e => setDeactivateMissing(e.target.checked)}
                />
                Deactivate any existing mapping not present in this file
              </label>

              <div className="overflow-x-auto max-h-80 overflow-y-auto border border-slate-200 rounded">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Shift ID</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Start</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">End</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.map((d, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-3 py-1.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${
                            d.state === 'new' ? 'bg-green-100 text-green-700'
                              : d.state === 'changed' ? 'bg-amber-100 text-amber-700'
                              : 'bg-slate-100 text-slate-500'
                          }`}>
                            {d.state}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[10px]">{d.row.shift_id}</td>
                        <td className="px-3 py-1.5 font-mono">{d.row.start_time}</td>
                        <td className="px-3 py-1.5 font-mono">{d.row.end_time}</td>
                        <td className="px-3 py-1.5 text-slate-500">
                          {d.state === 'changed' && d.before && (
                            <span className="font-mono text-[10px]">
                              was {d.before.start_time || '—'} → {d.before.end_time || '—'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={apply}
                  disabled={applying}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {applying ? 'Applying…' : 'Apply Changes'}
                </button>
                <button
                  onClick={cancel}
                  disabled={applying}
                  className="px-4 py-2 text-sm text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Current mappings table */}
        <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-slate-700">
              Current Mappings ({filtered.length}{!showInactive && mappings.some(m => !m.active) ? ` of ${mappings.length}` : ''})
            </h2>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={showInactive}
                  onChange={e => setShowInactive(e.target.checked)}
                />
                Show inactive
              </label>
              <input
                type="text"
                placeholder="Search shift id, label, campaign..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-72"
              />
            </div>
          </div>

          {loading ? (
            <div className="text-sm text-slate-500">Loading…</div>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Label</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Start</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">End</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Shift ID</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Campaign</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Active</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(m => (
                    <tr key={m.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-1.5 font-medium">{m.label}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{m.start_time || '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{m.end_time || '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500">{m.shift_id}</td>
                      <td className="px-3 py-1.5 text-slate-500">{m.campaign || '—'}</td>
                      <td className="px-3 py-1.5">
                        {m.active ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">active</span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-500">inactive</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-slate-500">
                        {new Date(m.updated_at).toLocaleDateString('en-ZA')}
                        {m.updated_by && <span className="block text-[10px] opacity-70">{m.updated_by}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && <div className="text-sm text-slate-500 p-3 text-center">No mappings match.</div>}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function MappingsPage() {
  return (
    <AuthGuard>
      <MappingsContent />
    </AuthGuard>
  );
}
