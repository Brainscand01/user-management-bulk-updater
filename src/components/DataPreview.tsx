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

  const validCount = validationResults.filter((r, idx) => r.valid && !duplicateADs?.has(idx)).length;
  const invalidCount = rows.length - validCount;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-sm">
        <span className="font-medium text-slate-700">{rows.length} rows loaded</span>
        <span className="text-green-600">{validCount} valid</span>
        {invalidCount > 0 && <span className="text-red-600">{invalidCount} with errors</span>}
      </div>

      <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-[500px] overflow-y-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 z-20">
            <tr className="bg-slate-100">
              <th className="px-3 py-2 text-left font-medium text-slate-600">
                #
              </th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">
                Status
              </th>
              <th className="px-3 py-2 text-left font-medium text-slate-600 min-w-[250px]">
                Errors
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
                  <td className="px-3 py-2 text-slate-500">
                    {idx + 1}
                  </td>
                  <td className="px-3 py-2">
                    {hasError ? (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                        FAIL
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                        OK
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 min-w-[250px]">
                    {hasError ? (
                      <div className="space-y-0.5">
                        {allErrors.map((e, i) => (
                          <div key={i} className="text-red-600 text-xs">{e}</div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-slate-400">-</span>
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
