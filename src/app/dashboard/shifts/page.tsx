'use client';

import { useRef, useState, useCallback, useMemo } from 'react';
import AuthGuard, { useCurrentUser } from '@/components/AuthGuard';
import NavHeader from '@/components/NavHeader';
import PageHeader from '@/components/PageHeader';
import FileUploader from '@/components/FileUploader';
import ShiftFileQueue, { type QueueAddHandle } from '@/components/ShiftFileQueue';
import OneDriveConnect, { type OneDrivePulledFile } from '@/components/OneDriveConnect';
import { extractSheetData, identifyScheduleSheets, SheetData } from '@/lib/shift-extractor';
import * as XLSX from 'xlsx';
import { USD_TO_ZAR } from '@/lib/currency';

interface ParsedShiftEntry {
  agentName: string;
  ad: string;
  day: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

interface SheetResult {
  sheetName: string;
  entries: ParsedShiftEntry[];
  skippedReason?: string;
}

interface ParseResponse {
  results: SheetResult[];
  totalEntries: number;
  totalAgents: number;
  sheetsProcessed: number;
  sheetsSkipped: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

type FilterMode = 'all' | 'working' | 'off' | 'low-confidence' | 'no-ad';

function ShiftsContent() {
  const user = useCurrentUser();
  const queueRef = useRef<QueueAddHandle | null>(null);
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [scheduleSheets, setScheduleSheets] = useState<SheetData[]>([]);
  const [selectedSheets, setSelectedSheets] = useState<Set<string>>(new Set());
  const [parseResult, setParseResult] = useState<ParseResponse | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [searchTerm, setSearchTerm] = useState('');

  const handleFileLoaded = useCallback((buffer: ArrayBuffer, name: string) => {
    setFileName(name);
    setParseResult(null);
    setError('');
    setIsExtracting(true);

    try {
      const allSheets = extractSheetData(buffer);
      setSheets(allSheets);

      const schedule = identifyScheduleSheets(allSheets);
      setScheduleSheets(schedule);

      // Auto-select all schedule sheets
      setSelectedSheets(new Set(schedule.map(s => s.sheetName)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read Excel file');
    }

    setIsExtracting(false);
  }, []);

  const toggleSheet = (sheetName: string) => {
    setSelectedSheets(prev => {
      const next = new Set(prev);
      if (next.has(sheetName)) next.delete(sheetName);
      else next.add(sheetName);
      return next;
    });
  };

  const selectAllSheets = () => {
    setSelectedSheets(new Set(sheets.map(s => s.sheetName)));
  };

  const selectScheduleOnly = () => {
    setSelectedSheets(new Set(scheduleSheets.map(s => s.sheetName)));
  };

  const handleParse = async () => {
    if (selectedSheets.size === 0) return;

    setIsParsing(true);
    setError('');
    setParseResult(null);

    const sheetsToSend = sheets.filter(s => selectedSheets.has(s.sheetName));
    const accumulatedResults: SheetResult[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    try {
      // Process sheets one at a time to stay under serverless timeouts
      for (let i = 0; i < sheetsToSend.length; i++) {
        const sheet = sheetsToSend[i];
        setParseProgress(`Parsing sheet ${i + 1} of ${sheetsToSend.length}: ${sheet.sheetName}`);

        let attempt = 0;
        let data: Record<string, unknown> | null = null;
        let lastError = '';
        while (attempt < 2 && !data) {
          attempt++;
          try {
            const res = await fetch('/api/shifts/parse', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fileName, sheet, userEmail: user?.email }),
            });
            const text = await res.text();
            try {
              data = JSON.parse(text);
            } catch {
              lastError = `Server returned non-JSON (${res.status}): ${text.slice(0, 120)}`;
              data = null;
            }
          } catch (err) {
            lastError = err instanceof Error ? err.message : 'Network error';
          }
        }

        if (!data || (data as { error?: string }).error) {
          accumulatedResults.push({
            sheetName: sheet.sheetName,
            entries: [],
            skippedReason: (data as { error?: string })?.error || lastError || 'Unknown error',
          });
          continue;
        }

        const sheetData = data as {
          results: SheetResult[];
          usage?: { inputTokens: number; outputTokens: number; costUsd: number };
        };
        if (sheetData.results?.[0]) {
          accumulatedResults.push(sheetData.results[0]);
        }
        if (sheetData.usage) {
          totalInputTokens += sheetData.usage.inputTokens;
          totalOutputTokens += sheetData.usage.outputTokens;
          totalCost += sheetData.usage.costUsd;
        }
      }

      // Finalize — save aggregated parse record + entries to DB
      setParseProgress('Saving results...');
      let parseId: string | null = null;
      try {
        const finRes = await fetch('/api/shifts/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName,
            results: accumulatedResults,
            totalInputTokens,
            totalOutputTokens,
            totalCost,
            userEmail: user?.email,
          }),
        });
        const finData = await finRes.json();
        parseId = finData.parseId || null;
      } catch {
        // non-fatal — results still shown in-memory
      }

      const allParsed = accumulatedResults.flatMap(r => r.entries);
      const sheetsSkipped = accumulatedResults.filter(r => r.skippedReason).length;
      const needsReview = allParsed.filter(e => e.confidence === 'low' || e.confidence === 'medium').length;
      const uniqueAgents = new Set(allParsed.map(e => e.ad || e.agentName)).size;

      setParseResult({
        results: accumulatedResults,
        totalEntries: allParsed.length,
        totalAgents: uniqueAgents,
        sheetsProcessed: accumulatedResults.length,
        sheetsSkipped,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          costUsd: totalCost,
        },
      });
      // Surface review hint if any sheet failed
      const failed = accumulatedResults.filter(r => r.skippedReason && r.entries.length === 0);
      if (failed.length > 0) {
        setError(`${failed.length} sheet(s) failed to parse: ${failed.slice(0, 3).map(r => r.sheetName).join(', ')}${failed.length > 3 ? '…' : ''}`);
      }
      // Use parseId to suppress unused-var warning; currently just consumed if needed later
      if (parseId) void parseId;
      setParseProgress('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse shifts');
    }

    setIsParsing(false);
  };

  // Aggregate all entries
  const allEntries = useMemo(() => {
    if (!parseResult) return [];
    return parseResult.results.flatMap(r => r.entries);
  }, [parseResult]);

  // Filtered entries
  const filteredEntries = useMemo(() => {
    let entries = allEntries;

    switch (filter) {
      case 'working':
        entries = entries.filter(e => e.status === 'working');
        break;
      case 'off':
        entries = entries.filter(e => e.status === 'off' || e.status === 'leave');
        break;
      case 'low-confidence':
        entries = entries.filter(e => e.confidence === 'low' || e.confidence === 'medium');
        break;
      case 'no-ad':
        entries = entries.filter(e => !e.ad);
        break;
    }

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      entries = entries.filter(e =>
        e.agentName.toLowerCase().includes(term) ||
        e.ad.toLowerCase().includes(term)
      );
    }

    return entries;
  }, [allEntries, filter, searchTerm]);

  // Unique agents in working entries
  const uniqueAgents = useMemo(() => {
    const working = allEntries.filter(e => e.status === 'working');
    return new Set(working.map(e => e.ad || e.agentName));
  }, [allEntries]);

  // Stats
  const stats = useMemo(() => {
    if (!parseResult) return null;
    const working = allEntries.filter(e => e.status === 'working');
    const withAD = working.filter(e => e.ad);
    const lowConf = allEntries.filter(e => e.confidence === 'low' || e.confidence === 'medium');
    return {
      totalEntries: allEntries.length,
      workingEntries: working.length,
      uniqueAgents: uniqueAgents.size,
      withAD: new Set(withAD.map(e => e.ad)).size,
      withoutAD: uniqueAgents.size - new Set(withAD.map(e => e.ad || e.agentName)).size,
      lowConfidence: lowConf.length,
      sheetsProcessed: parseResult.sheetsProcessed,
      sheetsSkipped: parseResult.sheetsSkipped,
    };
  }, [parseResult, allEntries, uniqueAgents]);

  const handleExportCSV = () => {
    if (filteredEntries.length === 0) return;
    const csv = [
      'Agent Name,AD/Username,Day,Date,Start Time,End Time,Status,Confidence,Notes',
      ...filteredEntries.map(e =>
        `"${e.agentName}","${e.ad}","${e.day}","${e.date}","${e.startTime}","${e.endTime}","${e.status}","${e.confidence}","${(e.notes || '').replace(/"/g, '""')}"`
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filterLabel = filter !== 'all' ? `_${filter}` : '';
    a.download = `shifts_${fileName.replace(/\.xlsx?$/i, '')}${filterLabel}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportExcel = () => {
    if (filteredEntries.length === 0) return;

    const wsData = [
      ['Agent Name', 'AD/Username', 'Day', 'Date', 'Start Time', 'End Time', 'Status', 'Confidence', 'Notes'],
      ...filteredEntries.map(e => [
        e.agentName, e.ad, e.day, e.date, e.startTime, e.endTime, e.status, e.confidence, e.notes || '',
      ]),
    ];

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      { wch: 25 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
      { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 30 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Shifts');

    const filterLabel = filter !== 'all' ? `_${filter}` : '';
    XLSX.writeFile(wb, `shifts_${fileName.replace(/\.xlsx?$/i, '')}${filterLabel}.xlsx`);
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

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      working: 'bg-blue-100 text-blue-700',
      off: 'bg-slate-100 text-slate-600',
      leave: 'bg-amber-100 text-amber-700',
      unknown: 'bg-red-100 text-red-700',
    };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status] || 'bg-slate-100'}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 pl-60">
      <NavHeader />

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <PageHeader
          title="AI Shift Parser"
          description="Upload any workforce planner Excel file and Claude will extract a clean list of agent shifts — detecting the format, normalizing times to SAST, and flagging anything uncertain for review. Supports multi-sheet workbooks with different layouts."
        />

        {/* Upload */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-sm font-medium text-slate-700 mb-3">
            Upload Shift Schedule
          </h2>
          <p className="text-xs text-slate-500 mb-3">
            Upload any workforce planner shift schedule (.xlsx). The AI will detect the format, extract agent shifts, and normalize the output.
          </p>
          <FileUploader onFileLoaded={handleFileLoaded} />
        </div>

        {/* OneDrive connect + folder picker */}
        <OneDriveConnect
          onFilesPulled={(files: OneDrivePulledFile[]) => {
            queueRef.current?.add(
              files.map(f => ({
                buffer: f.buffer,
                name: f.name,
                oneDrive: {
                  driveId: f.driveId,
                  itemId: f.itemId,
                  eTag: f.eTag,
                  size: f.size,
                  lastModified: f.lastModified,
                },
              })),
            );
          }}
        />

        {/* Multi-file queue */}
        <ShiftFileQueue ref={queueRef} userEmail={user?.email} />

        {/* Sheet Selection */}
        {sheets.length > 0 && !parseResult && (
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-medium text-slate-700">
                  Sheet Selection — {fileName}
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  {sheets.length} sheets found, {scheduleSheets.length} detected as schedules.
                  Select which sheets to send to AI for parsing.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={selectScheduleOnly}
                  className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-md hover:bg-slate-200 transition-colors"
                >
                  Auto-detect
                </button>
                <button
                  onClick={selectAllSheets}
                  className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-md hover:bg-slate-200 transition-colors"
                >
                  Select All
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mb-4">
              {sheets.map(sheet => {
                const isSchedule = scheduleSheets.some(s => s.sheetName === sheet.sheetName);
                const isSelected = selectedSheets.has(sheet.sheetName);
                return (
                  <button
                    key={sheet.sheetName}
                    onClick={() => toggleSheet(sheet.sheetName)}
                    className={`text-left px-3 py-2 rounded-md border text-xs transition-colors ${
                      isSelected
                        ? 'border-blue-300 bg-blue-50 text-blue-800'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <div className="font-medium truncate">{sheet.sheetName}</div>
                    <div className="text-[10px] mt-0.5 opacity-70">
                      {sheet.totalRows}r × {sheet.totalCols}c
                      {isSchedule && ' • schedule'}
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              onClick={handleParse}
              disabled={isParsing || selectedSheets.size === 0}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isParsing ? parseProgress || 'Processing...' : `Parse ${selectedSheets.size} Sheet${selectedSheets.size !== 1 ? 's' : ''} with AI`}
            </button>

            {isExtracting && (
              <p className="text-xs text-slate-500 mt-2">Reading Excel file...</p>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Loading */}
        {isParsing && (
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <div className="flex items-center gap-3">
              <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full"></div>
              <div>
                <p className="text-sm font-medium text-slate-700">AI is analyzing shift schedules...</p>
                <p className="text-xs text-slate-500 mt-1">{parseProgress}</p>
              </div>
            </div>
          </div>
        )}

        {/* Results Summary */}
        {stats && (
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Parse Results</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-2xl font-bold text-slate-900">{stats.uniqueAgents}</div>
                <div className="text-xs text-slate-500">Unique Agents</div>
              </div>
              <div className="bg-blue-50 rounded-lg p-3">
                <div className="text-2xl font-bold text-blue-700">{stats.workingEntries}</div>
                <div className="text-xs text-blue-600">Working Shifts</div>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <div className="text-2xl font-bold text-green-700">{stats.withAD}</div>
                <div className="text-xs text-green-600">Agents with AD</div>
              </div>
              <div className={`rounded-lg p-3 ${stats.lowConfidence > 0 ? 'bg-amber-50' : 'bg-slate-50'}`}>
                <div className={`text-2xl font-bold ${stats.lowConfidence > 0 ? 'text-amber-700' : 'text-slate-400'}`}>
                  {stats.lowConfidence}
                </div>
                <div className={`text-xs ${stats.lowConfidence > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                  Needs Review
                </div>
                {stats.lowConfidence > 0 && (
                  <div className="text-[10px] text-amber-500 mt-0.5">AI was unsure — verify these entries</div>
                )}
              </div>
              {parseResult?.usage && (
                <div className="bg-purple-50 rounded-lg p-3">
                  <div className="text-2xl font-bold text-purple-700">
                    ${parseResult.usage.costUsd.toFixed(4)}{' '}
                    <span className="text-base font-semibold text-purple-500">
                      (R{(parseResult.usage.costUsd * USD_TO_ZAR).toFixed(2)})
                    </span>
                  </div>
                  <div className="text-xs text-purple-600">
                    Parse Cost ({parseResult.usage.inputTokens.toLocaleString()}↓ {parseResult.usage.outputTokens.toLocaleString()}↑)
                  </div>
                </div>
              )}
            </div>

            {/* Sheet breakdown */}
            <div className="mb-4">
              <h3 className="text-xs font-medium text-slate-600 mb-2">Sheet Breakdown</h3>
              <div className="flex flex-wrap gap-2">
                {parseResult?.results.map(r => (
                  <div
                    key={r.sheetName}
                    className={`px-2 py-1 rounded text-xs ${
                      r.skippedReason
                        ? 'bg-slate-100 text-slate-500'
                        : r.entries.length > 0
                          ? 'bg-green-100 text-green-700'
                          : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {r.sheetName}: {r.skippedReason ? 'skipped' : `${r.entries.length} entries`}
                  </div>
                ))}
              </div>
            </div>

            {/* Filters + Search + Export */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <div className="flex gap-1 bg-slate-100 p-0.5 rounded-md">
                  {([
                    { key: 'all', label: 'All' },
                    { key: 'working', label: 'Working' },
                    { key: 'off', label: 'Off/Leave' },
                    { key: 'low-confidence', label: 'Needs Review' },
                    { key: 'no-ad', label: 'No AD' },
                  ] as { key: FilterMode; label: string }[]).map(f => (
                    <button
                      key={f.key}
                      onClick={() => setFilter(f.key)}
                      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                        filter === f.key
                          ? 'bg-white text-slate-900 shadow-sm'
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
                  onClick={handleExportCSV}
                  disabled={filteredEntries.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors disabled:opacity-50"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export CSV
                </button>
                <button
                  onClick={handleExportExcel}
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

            {/* Results Table */}
            <div className="text-xs text-slate-500 mb-2">
              Showing {filteredEntries.length} of {allEntries.length} entries
            </div>
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
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Conf.</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.slice(0, 500).map((entry, i) => (
                    <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-1.5 whitespace-nowrap">{entry.agentName}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">
                        {entry.ad || <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">{entry.day}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-slate-500">{entry.date}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">{entry.startTime || '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">{entry.endTime || '—'}</td>
                      <td className="px-3 py-1.5">{statusBadge(entry.status)}</td>
                      <td className="px-3 py-1.5">{confidenceBadge(entry.confidence)}</td>
                      <td className="px-3 py-1.5 text-slate-500 max-w-xs truncate" title={entry.notes}>
                        {entry.notes || '—'}
                      </td>
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
          </div>
        )}

        {/* Re-parse button */}
        {parseResult && (
          <div className="flex justify-center">
            <button
              onClick={() => {
                setParseResult(null);
                setFilter('all');
                setSearchTerm('');
              }}
              className="px-4 py-2 text-sm text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
            >
              Upload Another File
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default function ShiftsPage() {
  return (
    <AuthGuard>
      <ShiftsContent />
    </AuthGuard>
  );
}
