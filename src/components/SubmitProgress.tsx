'use client';

export interface RowStatus {
  rowIndex: number;
  employeeName: string;
  status: 'pending' | 'processing' | 'success' | 'failed';
  message?: string;
}

interface SubmitProgressProps {
  statuses: RowStatus[];
  isRunning: boolean;
  onExportResults: () => void;
}

export default function SubmitProgress({ statuses, isRunning, onExportResults }: SubmitProgressProps) {
  const total = statuses.length;
  const completed = statuses.filter(s => s.status === 'success' || s.status === 'failed').length;
  const successful = statuses.filter(s => s.status === 'success').length;
  const failed = statuses.filter(s => s.status === 'failed').length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">
          Processing: {completed} / {total}
        </div>
        <div className="flex gap-3 text-sm">
          <span className="text-green-600">{successful} success</span>
          {failed > 0 && <span className="text-red-600">{failed} failed</span>}
        </div>
      </div>

      <div className="w-full bg-slate-200 rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-300 ${
            failed > 0 ? 'bg-amber-500' : 'bg-blue-600'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="max-h-60 overflow-y-auto border border-slate-200 rounded-lg">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="px-3 py-2 text-left font-medium text-slate-600">Row</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Employee</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Message</th>
            </tr>
          </thead>
          <tbody>
            {statuses.map((s) => (
              <tr key={s.rowIndex} className="border-t border-slate-100">
                <td className="px-3 py-1.5 text-slate-500">{s.rowIndex + 1}</td>
                <td className="px-3 py-1.5">{s.employeeName}</td>
                <td className="px-3 py-1.5">
                  {s.status === 'pending' && <span className="text-slate-400">Pending</span>}
                  {s.status === 'processing' && (
                    <span className="text-blue-600 flex items-center gap-1">
                      <span className="animate-spin inline-block w-3 h-3 border border-blue-600 border-t-transparent rounded-full" />
                      Processing
                    </span>
                  )}
                  {s.status === 'success' && <span className="text-green-600">Success</span>}
                  {s.status === 'failed' && <span className="text-red-600">Failed</span>}
                </td>
                <td className="px-3 py-1.5 text-slate-500 max-w-xs truncate" title={s.message}>
                  {s.message || '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!isRunning && completed > 0 && (
        <button
          onClick={onExportResults}
          className="px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md transition-colors"
        >
          Export Results as CSV
        </button>
      )}
    </div>
  );
}
