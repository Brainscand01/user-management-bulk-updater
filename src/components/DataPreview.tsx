'use client';

import { ValidationResult } from '@/lib/validation';

interface DataPreviewProps {
  headers: string[];
  rows: Record<string, unknown>[];
  validationResults: ValidationResult[];
  duplicateADs?: Map<number, string>;
}

export default function DataPreview({ headers, rows, validationResults, duplicateADs }: DataPreviewProps) {
  if (rows.length === 0) return null;

  const validCount = validationResults.filter(r => r.valid && !duplicateADs?.has(validationResults.indexOf(r))).length;
  const invalidCount = rows.length - validCount;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-sm">
        <span className="font-medium text-slate-700">{rows.length} rows loaded</span>
        <span className="text-green-600">{validCount} valid</span>
        {invalidCount > 0 && <span className="text-red-600">{invalidCount} with errors</span>}
      </div>

      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="px-3 py-2 text-left font-medium text-slate-600 sticky left-0 bg-slate-100 z-10">
                #
              </th>
              <th className="px-3 py-2 text-left font-medium text-slate-600 sticky left-8 bg-slate-100 z-10">
                Status
              </th>
              {headers.map(h => (
                <th key={h} className="px-3 py-2 text-left font-medium text-slate-600 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const validation = validationResults[idx];
              const dupError = duplicateADs?.get(idx);
              const hasError = !validation?.valid || !!dupError;
              const allErrors = [
                ...(validation?.errors || []).map(e => `${e.field}: ${e.message}`),
                ...(dupError ? [dupError] : []),
              ];

              return (
                <tr
                  key={idx}
                  className={`border-t border-slate-100 ${hasError ? 'bg-red-50' : 'hover:bg-slate-50'}`}
                >
                  <td className="px-3 py-2 text-slate-500 sticky left-0 bg-inherit z-10">
                    {idx + 1}
                  </td>
                  <td className="px-3 py-2 sticky left-8 bg-inherit z-10">
                    {hasError ? (
                      <div className="group relative">
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 cursor-help">
                          FAIL
                        </span>
                        <div className="hidden group-hover:block absolute z-20 left-0 top-full mt-1 w-64 bg-white border border-red-200 rounded shadow-lg p-2 text-xs text-red-700">
                          {allErrors.map((e, i) => (
                            <div key={i} className="py-0.5">{e}</div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                        OK
                      </span>
                    )}
                  </td>
                  {headers.map(h => (
                    <td key={h} className="px-3 py-2 whitespace-nowrap max-w-[200px] truncate" title={String(row[h] || '')}>
                      {String(row[h] || '')}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
