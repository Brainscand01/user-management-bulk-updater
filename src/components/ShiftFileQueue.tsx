'use client';

import { useCallback, useState } from 'react';
import FileUploader from '@/components/FileUploader';
import { extractSheetData, identifyScheduleSheets, SheetData } from '@/lib/shift-extractor';
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

type QueueStatus = 'queued' | 'extracting' | 'parsing' | 'finalizing' | 'done' | 'failed' | 'skipped';

interface QueueItem {
  id: string;
  fileName: string;
  buffer: ArrayBuffer;
  status: QueueStatus;
  totalSheets: number;
  selectedSheets: number;
  currentSheet: number;
  currentSheetName: string;
  totalEntries: number;
  uniqueAgents: number;
  needsReview: number;
  costUsd: number;
  parseId: string | null;
  errorMessage: string;
}

interface ShiftFileQueueProps {
  userEmail: string | undefined;
}

let nextId = 0;

export default function ShiftFileQueue({ userEmail }: ShiftFileQueueProps) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const update = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue(prev => prev.map(q => q.id === id ? { ...q, ...patch } : q));
  }, []);

  const handleFilesLoaded = useCallback((files: { buffer: ArrayBuffer; name: string }[]) => {
    const newItems: QueueItem[] = files.map(f => ({
      id: `q-${++nextId}`,
      fileName: f.name,
      buffer: f.buffer,
      status: 'queued',
      totalSheets: 0,
      selectedSheets: 0,
      currentSheet: 0,
      currentSheetName: '',
      totalEntries: 0,
      uniqueAgents: 0,
      needsReview: 0,
      costUsd: 0,
      parseId: null,
      errorMessage: '',
    }));
    setQueue(prev => [...prev, ...newItems]);
  }, []);

  async function processItem(item: QueueItem): Promise<void> {
    // 1. Extract sheets locally
    update(item.id, { status: 'extracting' });
    let allSheets: SheetData[];
    let scheduleSheets: SheetData[];
    try {
      allSheets = extractSheetData(item.buffer);
      scheduleSheets = identifyScheduleSheets(allSheets);
    } catch (err) {
      update(item.id, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Failed to read Excel file',
      });
      return;
    }

    if (scheduleSheets.length === 0) {
      update(item.id, {
        status: 'skipped',
        totalSheets: allSheets.length,
        errorMessage: 'No agent-schedule sheets auto-detected',
      });
      return;
    }

    update(item.id, {
      status: 'parsing',
      totalSheets: allSheets.length,
      selectedSheets: scheduleSheets.length,
    });

    // 2. Parse each sheet sequentially
    const accumulatedResults: SheetResult[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    for (let i = 0; i < scheduleSheets.length; i++) {
      const sheet = scheduleSheets[i];
      update(item.id, {
        currentSheet: i + 1,
        currentSheetName: sheet.sheetName,
      });

      let attempt = 0;
      let data: Record<string, unknown> | null = null;
      let lastError = '';
      while (attempt < 2 && !data) {
        attempt++;
        try {
          const res = await fetch('/api/shifts/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName: item.fileName, sheet, userEmail }),
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

      // Live-update the running cost on the queue item
      update(item.id, { costUsd: totalCost });
    }

    // 3. Finalize → save to DB
    update(item.id, { status: 'finalizing' });
    let parseId: string | null = null;
    try {
      const finRes = await fetch('/api/shifts/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: item.fileName,
          results: accumulatedResults,
          totalInputTokens,
          totalOutputTokens,
          totalCost,
          userEmail,
        }),
      });
      const finData = await finRes.json();
      parseId = finData.parseId || null;
    } catch {
      // non-fatal
    }

    const allEntries = accumulatedResults.flatMap(r => r.entries);
    const uniqueAgents = new Set(allEntries.map(e => e.ad || e.agentName)).size;
    const needsReview = allEntries.filter(e => e.confidence === 'low' || e.confidence === 'medium').length;
    const failedSheets = accumulatedResults.filter(r => r.skippedReason && r.entries.length === 0).length;

    update(item.id, {
      status: 'done',
      totalEntries: allEntries.length,
      uniqueAgents,
      needsReview,
      costUsd: totalCost,
      parseId,
      errorMessage: failedSheets > 0 ? `${failedSheets} sheet(s) failed` : '',
    });
  }

  const startProcessing = useCallback(async () => {
    setIsProcessing(true);
    // Snapshot the queued items at start; new files added mid-run are picked up
    // on next click of "Process Queue"
    const toProcess = queue.filter(q => q.status === 'queued');
    for (const item of toProcess) {
      await processItem(item);
    }
    setIsProcessing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  function removeItem(id: string) {
    setQueue(prev => prev.filter(q => q.id !== id));
  }

  function clearCompleted() {
    setQueue(prev => prev.filter(q => q.status !== 'done' && q.status !== 'skipped' && q.status !== 'failed'));
  }

  function clearAll() {
    if (isProcessing) {
      if (!confirm('Processing in progress — items already started will keep running. Clear queue anyway?')) return;
    }
    setQueue([]);
  }

  // Cumulative totals across all done items
  const totals = queue.reduce(
    (acc, q) => {
      if (q.status === 'done') {
        acc.entries += q.totalEntries;
        acc.agents += q.uniqueAgents;
        acc.needsReview += q.needsReview;
        acc.cost += q.costUsd;
        acc.completed++;
      }
      return acc;
    },
    { entries: 0, agents: 0, needsReview: 0, cost: 0, completed: 0 }
  );

  const queuedCount = queue.filter(q => q.status === 'queued').length;

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
      <div>
        <h2 className="text-sm font-medium text-slate-700">Multi-File Queue</h2>
        <p className="text-xs text-slate-500 mt-1">
          Drop several workforce planner files at once. Each file is processed independently using auto-detected schedule sheets and saved as its own parse you can find in Shift History.
        </p>
      </div>

      <FileUploader
        multiple
        inputId="queue-upload"
        onFilesLoaded={handleFilesLoaded}
      />

      {queue.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              onClick={startProcessing}
              disabled={isProcessing || queuedCount === 0}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isProcessing ? 'Processing…' : `Process Queue (${queuedCount} pending)`}
            </button>
            <button
              onClick={clearCompleted}
              disabled={isProcessing}
              className="px-3 py-2 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md disabled:opacity-50"
            >
              Clear completed
            </button>
            <button
              onClick={clearAll}
              className="px-3 py-2 text-xs text-red-600 bg-red-50 hover:bg-red-100 rounded-md"
            >
              Clear all
            </button>

            {totals.completed > 0 && (
              <div className="ml-auto text-xs text-slate-600 flex items-center gap-3">
                <span><strong>{totals.completed}</strong> done</span>
                <span><strong>{totals.entries.toLocaleString()}</strong> entries</span>
                <span><strong>{totals.agents.toLocaleString()}</strong> agents</span>
                {totals.needsReview > 0 && (
                  <span className="text-amber-700"><strong>{totals.needsReview}</strong> need review</span>
                )}
                <span className="font-mono">
                  ${totals.cost.toFixed(4)} <span className="text-slate-400">(R{(totals.cost * USD_TO_ZAR).toFixed(2)})</span>
                </span>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className="px-3 py-2 text-left font-medium text-slate-600">File</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Sheets</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Entries</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Agents</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Review</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Cost</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.map(q => (
                  <tr key={q.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 max-w-xs">
                      <div className="truncate font-medium" title={q.fileName}>{q.fileName}</div>
                      {q.errorMessage && (
                        <div className="text-[10px] text-red-600 mt-0.5 truncate" title={q.errorMessage}>
                          {q.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={q.status} /></td>
                    <td className="px-3 py-2 text-slate-600">
                      {q.status === 'parsing' && q.selectedSheets > 0 ? (
                        <div>
                          <div>{q.currentSheet} / {q.selectedSheets}</div>
                          <div className="text-[10px] text-slate-400 truncate max-w-[140px]" title={q.currentSheetName}>
                            {q.currentSheetName}
                          </div>
                        </div>
                      ) : q.selectedSheets > 0 ? (
                        <span>{q.selectedSheets} of {q.totalSheets}</span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{q.status === 'done' ? q.totalEntries.toLocaleString() : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{q.status === 'done' ? q.uniqueAgents.toLocaleString() : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {q.status === 'done' ? (
                        q.needsReview > 0 ? (
                          <span className="text-amber-700 font-medium">{q.needsReview}</span>
                        ) : (
                          <span className="text-green-600">0</span>
                        )
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {q.costUsd > 0 ? (
                        <>
                          ${q.costUsd.toFixed(4)}
                          <div className="text-[10px] text-slate-400">R{(q.costUsd * USD_TO_ZAR).toFixed(2)}</div>
                        </>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {q.status === 'done' && q.parseId ? (
                        <a
                          href={`/dashboard/shifts/history`}
                          className="text-blue-600 hover:text-blue-800 font-medium"
                        >
                          View
                        </a>
                      ) : q.status === 'queued' ? (
                        <button
                          onClick={() => removeItem(q.id)}
                          className="text-red-600 hover:text-red-800 font-medium"
                        >
                          Remove
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: QueueStatus }) {
  const styles: Record<QueueStatus, { bg: string; text: string; label: string }> = {
    queued:     { bg: 'bg-slate-100',  text: 'text-slate-600', label: 'Queued' },
    extracting: { bg: 'bg-blue-50',    text: 'text-blue-700',  label: 'Extracting' },
    parsing:    { bg: 'bg-blue-100',   text: 'text-blue-700',  label: 'Parsing' },
    finalizing: { bg: 'bg-purple-100', text: 'text-purple-700',label: 'Saving' },
    done:       { bg: 'bg-green-100',  text: 'text-green-700', label: 'Done' },
    failed:     { bg: 'bg-red-100',    text: 'text-red-700',   label: 'Failed' },
    skipped:    { bg: 'bg-amber-100',  text: 'text-amber-700', label: 'Skipped' },
  };
  const s = styles[status];
  const pulse = status === 'extracting' || status === 'parsing' || status === 'finalizing';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${s.bg} ${s.text}`}>
      {pulse && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
      {s.label}
    </span>
  );
}
