'use client';

import { useEffect, useState, useMemo } from 'react';
import AuthGuard from '@/components/AuthGuard';
import NavHeader from '@/components/NavHeader';
import { createClient } from '@/lib/supabase';
import { USD_TO_ZAR } from '@/lib/currency';
import * as XLSX from 'xlsx';

interface ShiftParse {
  id: string;
  file_name: string;
  sheets_processed: number;
  sheets_skipped: number;
  total_entries: number;
  unique_agents: number;
  needs_review: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  processed_by: string | null;
  created_at: string;
}

interface ShiftEntry {
  id: string;
  parse_id: string;
  sheet_name: string;
  agent_name: string;
  ad: string | null;
  day: string;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
  confidence: string;
  notes: string | null;
}

type EntryFilter = 'all' | 'working' | 'needs-review' | 'no-ad';

function ShiftHistoryContent() {
  const [parses, setParses] = useState<ShiftParse[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedParse, setSelectedParse] = useState<string | null>(null);
  const [entries, setEntries] = useState<ShiftEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entryFilter, setEntryFilter] = useState<EntryFilter>('all');
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    loadParses();
  }, []);

  async function loadParses() {
    setLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('um_shift_parses')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    setParses(data || []);
    setLoading(false);
  }

  async function loadEntries(parseId: string) {
    setSelectedParse(parseId);
    setEntryFilter('all');
    setSearchTerm('');
    setEntriesLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('um_shift_parse_entries')
      .select('*')
      .eq('parse_id', parseId)
      .order('agent_name', { ascending: true });
    setEntries(data || []);
    setEntriesLoading(false);
  }

  const filteredEntries = useMemo(() => {
    let result = entries;
    switch (entryFilter) {
      case 'working':
        result = result.filter(e => e.status === 'working');
        break;
      case 'needs-review':
        result = result.filter(e => e.confidence === 'low' || e.confidence === 'medium');
        break;
      case 'no-ad':
        result = result.filter(e => !e.ad);
        break;
    }
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(e =>
        e.agent_name.toLowerCase().includes(term) ||
        (e.ad || '').toLowerCase().includes(term)
      );
    }
    return result;
  }, [entries, entryFilter, searchTerm]);

  const reviewCount = useMemo(() =>
    entries.filter(e => e.confidence === 'low' || e.confidence === 'medium').length,
  [entries]);

  const noAdCount = useMemo(() =>
    entries.filter(e => !e.ad).length,
  [entries]);

  function exportEntries() {
    if (filteredEntries.length === 0) return;
    const parse = parses.find(p => p.id === selectedParse);
    const wsData = [
      ['Agent Name', 'AD/Username', 'Day', 'Date', 'Start Time', 'End Time', 'Status', 'Confidence', 'Sheet', 'Notes'],
      ...filteredEntries.map(e => [
        e.agent_name, e.ad || '', e.day, e.date || '', e.start_time || '',
        e.end_time || '', e.status, e.confidence, e.sheet_name || '', e.notes || '',
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      { wch: 25 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
      { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 20 }, { wch: 30 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Shifts');
    const filterLabel = entryFilter !== 'all' ? `_${entryFilter}` : '';
    XLSX.writeFile(wb, `shifts_${parse?.file_name?.replace(/\.xlsx?$/i, '') || 'export'}${filterLabel}.xlsx`);
  }

  function exportCSV() {
    if (filteredEntries.length === 0) return;
    const parse = parses.find(p => p.id === selectedParse);
    const csv = [
      'Agent Name,AD/Username,Day,Date,Start Time,End Time,Status,Confidence,Sheet,Notes',
      ...filteredEntries.map(e =>
        `"${e.agent_name}","${e.ad || ''}","${e.day}","${e.date || ''}","${e.start_time || ''}","${e.end_time || ''}","${e.status}","${e.confidence}","${e.sheet_name || ''}","${(e.notes || '').replace(/"/g, '""')}"`
      ),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filterLabel = entryFilter !== 'all' ? `_${entryFilter}` : '';
    a.download = `shifts_${parse?.file_name?.replace(/\.xlsx?$/i, '') || 'export'}${filterLabel}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('en-ZA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const confidenceBadge = (conf: string) => {
    const styles: Record<string, string> = {
      high: 'bg-green-100 text-green-700',
      medium: 'bg-amber-100 text-amber-700',
      low: 'bg-red-100 text-red-700',
    };
    const labels: Record<string, string> = {
      high: 'Verified',
      medium: 'Review',
      low: 'Uncertain',
    };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[conf] || 'bg-slate-100'}`}>
        {labels[conf] || conf}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <NavHeader />

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <h1 className="text-lg font-bold text-slate-900">Shift Parse History</h1>

        {/* Parse list */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-sm font-medium text-slate-700 mb-4">Past Uploads</h2>

          {loading ? (
            <div className="text-sm text-slate-500">Loading...</div>
          ) : parses.length === 0 ? (
            <div className="text-sm text-slate-500">No shift files processed yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Date</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">File Name</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Agents</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Shifts</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Needs Review</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Cost</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Processed By</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600"></th>
                  </tr>
                </thead>
                <tbody>
                  {parses.map(p => (
                    <tr
                      key={p.id}
                      className={`border-t border-slate-100 hover:bg-slate-50 ${selectedParse === p.id ? 'bg-blue-50' : ''}`}
                    >
                      <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{formatDate(p.created_at)}</td>
                      <td className="px-3 py-2 font-medium max-w-xs truncate" title={p.file_name}>{p.file_name}</td>
                      <td className="px-3 py-2 text-slate-600">{p.unique_agents}</td>
                      <td className="px-3 py-2 text-slate-600">{p.total_entries}</td>
                      <td className="px-3 py-2">
                        {p.needs_review > 0 ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                            {p.needs_review}
                          </span>
                        ) : (
                          <span className="text-green-600 text-xs font-medium">All clear</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        ${Number(p.cost_usd).toFixed(4)}{' '}
                        <span className="text-slate-400">(R{(Number(p.cost_usd) * USD_TO_ZAR).toFixed(2)})</span>
                      </td>
                      <td className="px-3 py-2 text-slate-500 text-xs">{p.processed_by || '—'}</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => loadEntries(p.id)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Entry detail */}
        {selectedParse && (
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-medium text-slate-700">Shift Entries</h2>
                <div className="flex gap-1 bg-slate-100 p-0.5 rounded-md">
                  {([
                    { key: 'all' as EntryFilter, label: `All (${entries.length})` },
                    { key: 'working' as EntryFilter, label: `Working (${entries.filter(e => e.status === 'working').length})` },
                    { key: 'needs-review' as EntryFilter, label: `Needs Review (${reviewCount})` },
                    { key: 'no-ad' as EntryFilter, label: `No AD (${noAdCount})` },
                  ]).map(f => (
                    <button
                      key={f.key}
                      onClick={() => setEntryFilter(f.key)}
                      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                        entryFilter === f.key
                          ? f.key === 'needs-review' ? 'bg-amber-100 text-amber-700'
                            : f.key === 'no-ad' ? 'bg-red-100 text-red-700'
                            : 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="Search agent or AD..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-48"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={exportCSV}
                  disabled={filteredEntries.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors disabled:opacity-50"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export CSV
                </button>
                <button
                  onClick={exportEntries}
                  disabled={filteredEntries.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-600 bg-green-50 rounded-md hover:bg-green-100 transition-colors disabled:opacity-50"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export Excel
                </button>
              </div>
            </div>

            <div className="text-xs text-slate-500 mb-2">
              Showing {filteredEntries.length} of {entries.length} entries
            </div>

            {entriesLoading ? (
              <div className="text-sm text-slate-500">Loading entries...</div>
            ) : filteredEntries.length === 0 ? (
              <div className="text-sm text-slate-500">No matching entries.</div>
            ) : (
              <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                <table className="min-w-full text-sm">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-slate-50">
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Agent</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">AD</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Day</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Date</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Start</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">End</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Confidence</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Sheet</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.slice(0, 500).map(e => (
                      <tr key={e.id} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-3 py-1.5 whitespace-nowrap">{e.agent_name}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">
                          {e.ad || <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">{e.day}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-slate-500">{e.date || '—'}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">{e.start_time || '—'}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">{e.end_time || '—'}</td>
                        <td className="px-3 py-1.5">{confidenceBadge(e.confidence)}</td>
                        <td className="px-3 py-1.5 text-slate-500 text-xs max-w-[120px] truncate" title={e.sheet_name}>{e.sheet_name || '—'}</td>
                        <td className="px-3 py-1.5 text-slate-500 max-w-xs truncate" title={e.notes || ''}>{e.notes || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredEntries.length > 500 && (
                  <div className="text-xs text-slate-500 p-3 text-center">
                    Showing first 500 of {filteredEntries.length} entries. Export to see all.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function ShiftHistoryPage() {
  return (
    <AuthGuard>
      <ShiftHistoryContent />
    </AuthGuard>
  );
}
