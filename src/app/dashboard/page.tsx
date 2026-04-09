'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AuthGuard, { useCurrentUser } from '@/components/AuthGuard';
import FileUploader from '@/components/FileUploader';
import DataPreview from '@/components/DataPreview';
import SubmitProgress, { RowStatus } from '@/components/SubmitProgress';
import { createClient } from '@/lib/supabase';
import { parseExcelFile, buildCreateBody, buildUpdateBody, buildShiftBody, ParseResult } from '@/lib/excel-parser';
import {
  validateCreateUser, validateUpdateUser, validateShiftUpdate,
  checkDuplicateADs, ValidationResult
} from '@/lib/validation';

type Tab = 'create' | 'update' | 'shift_update';

function DashboardContent() {
  const router = useRouter();
  const user = useCurrentUser();
  const [activeTab, setActiveTab] = useState<Tab>('create');
  const [parseResults, setParseResults] = useState<ParseResult | null>(null);
  const [validationResults, setValidationResults] = useState<ValidationResult[]>([]);
  const [duplicateADs, setDuplicateADs] = useState<Map<number, string>>(new Map());
  const [rowStatuses, setRowStatuses] = useState<RowStatus[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fileName, setFileName] = useState('');

  const handleFileLoaded = useCallback((buffer: ArrayBuffer, name: string) => {
    setFileName(name);
    setRowStatuses([]);
    const results = parseExcelFile(buffer);

    // Find matching sheet for current tab
    let matched = results.find(r => r.operation === activeTab);
    if (!matched && results.length > 0) {
      matched = results[0];
      setActiveTab(matched.operation);
    }

    if (!matched) {
      alert('No valid data found in the uploaded file.');
      return;
    }

    setParseResults(matched);

    // Validate
    const validator = matched.operation === 'create' ? validateCreateUser
      : matched.operation === 'update' ? validateUpdateUser
      : validateShiftUpdate;

    const validations = matched.rows.map(row => validator(row));
    setValidationResults(validations);

    // Check duplicate ADs for create operations
    if (matched.operation === 'create') {
      setDuplicateADs(checkDuplicateADs(matched.rows));
    } else {
      setDuplicateADs(new Map());
    }
  }, [activeTab]);

  const handleSubmit = async () => {
    if (!parseResults || !user) return;

    const validRows = parseResults.rows
      .map((row, idx) => ({ row, idx }))
      .filter(({ idx }) => validationResults[idx]?.valid && !duplicateADs.has(idx));

    if (validRows.length === 0) {
      alert('No valid rows to submit.');
      return;
    }

    setIsSubmitting(true);

    // Initialize statuses
    const initialStatuses: RowStatus[] = validRows.map(({ row, idx }) => ({
      rowIndex: idx,
      employeeName: `${row['Name'] || ''} ${row['Surname'] || ''}`.trim() || `Row ${idx + 1}`,
      status: 'pending',
    }));
    setRowStatuses(initialStatuses);

    // Create batch in Supabase
    const supabase = createClient();
    const { data: batch } = await supabase.from('batches').insert({
      operation: parseResults.operation,
      file_name: fileName,
      total_records: validRows.length,
      status: 'processing',
      processed_by: user.email || 'unknown',
    }).select().single();

    const batchId = batch?.id;

    // Process rows sequentially
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < validRows.length; i++) {
      const { row, idx } = validRows[i];

      // Update status to processing
      setRowStatuses(prev => prev.map((s, j) =>
        j === i ? { ...s, status: 'processing' } : s
      ));

      try {
        let body: Record<string, unknown>;
        let endpoint: string;

        if (parseResults.operation === 'create') {
          body = buildCreateBody(row);
          endpoint = '/api/proxy/create';
        } else if (parseResults.operation === 'update') {
          body = buildUpdateBody(row);
          endpoint = `/api/proxy/update?UserId=${row['UserId']}`;
        } else {
          body = buildShiftBody(row);
          endpoint = `/api/proxy/update?UserId=${row['UserId']}`;
        }

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const data = await res.json();

        const isSuccess = res.ok && !data.isError;

        // Save record to Supabase
        if (batchId) {
          await supabase.from('batch_records').insert({
            batch_id: batchId,
            row_number: idx + 1,
            employee_name: `${row['Name'] || ''} ${row['Surname'] || ''}`.trim(),
            employee_code: String(row['EmployeeCode'] || ''),
            operation: parseResults.operation,
            request_data: body,
            response_data: data,
            status: isSuccess ? 'success' : 'failed',
            error_message: isSuccess ? null : (data.message || data.result || 'Unknown error'),
            processed_at: new Date().toISOString(),
          });
        }

        if (isSuccess) {
          successCount++;
          setRowStatuses(prev => prev.map((s, j) =>
            j === i ? { ...s, status: 'success', message: data.message || 'Success' } : s
          ));
        } else {
          failCount++;
          setRowStatuses(prev => prev.map((s, j) =>
            j === i ? { ...s, status: 'failed', message: data.message || data.result || 'API Error' } : s
          ));
        }
      } catch (err) {
        failCount++;
        const message = err instanceof Error ? err.message : 'Network error';
        setRowStatuses(prev => prev.map((s, j) =>
          j === i ? { ...s, status: 'failed', message } : s
        ));

        if (batchId) {
          await supabase.from('batch_records').insert({
            batch_id: batchId,
            row_number: idx + 1,
            employee_name: `${row['Name'] || ''} ${row['Surname'] || ''}`.trim(),
            employee_code: String(row['EmployeeCode'] || ''),
            operation: parseResults.operation,
            request_data: {},
            status: 'failed',
            error_message: message,
            processed_at: new Date().toISOString(),
          });
        }
      }
    }

    // Update batch
    if (batchId) {
      await supabase.from('batches').update({
        successful: successCount,
        failed: failCount,
        status: failCount === 0 ? 'completed' : successCount === 0 ? 'completed' : 'partial',
        completed_at: new Date().toISOString(),
      }).eq('id', batchId);
    }

    setIsSubmitting(false);
  };

  const handleExportResults = () => {
    if (rowStatuses.length === 0) return;
    const csv = [
      'Row,Employee,Status,Message',
      ...rowStatuses.map(s =>
        `${s.rowIndex + 1},"${s.employeeName}",${s.status},"${(s.message || '').replace(/"/g, '""')}"`
      )
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `results_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/login');
  };

  const validCount = validationResults.filter((r, idx) => r.valid && !duplicateADs.has(idx)).length;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'create', label: 'Bulk Create' },
    { key: 'update', label: 'Bulk Update' },
    { key: 'shift_update', label: 'Shift Update' },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold text-slate-900">UM Bulk Updater</h1>
          <button
            onClick={() => router.push('/dashboard/history')}
            className="text-sm text-slate-500 hover:text-slate-700 transition-colors"
          >
            History
          </button>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-500">{user?.email}</span>
          <button
            onClick={handleSignOut}
            className="text-sm text-slate-500 hover:text-red-600 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Tabs */}
        <div className="flex gap-1 bg-slate-200 p-1 rounded-lg w-fit">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                setParseResults(null);
                setValidationResults([]);
                setRowStatuses([]);
                setDuplicateADs(new Map());
              }}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                activeTab === tab.key
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Upload */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-sm font-medium text-slate-700 mb-3">
            Upload Excel File — {tabs.find(t => t.key === activeTab)?.label}
          </h2>
          <FileUploader onFileLoaded={handleFileLoaded} />
        </div>

        {/* Preview */}
        {parseResults && (
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-slate-700">
                Data Preview — Sheet: {parseResults.sheetName}
              </h2>
              {!isSubmitting && rowStatuses.length === 0 && validCount > 0 && (
                <button
                  onClick={handleSubmit}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  Submit {validCount} Valid Row{validCount !== 1 ? 's' : ''}
                </button>
              )}
            </div>
            <DataPreview
              headers={parseResults.headers}
              rows={parseResults.rows}
              validationResults={validationResults}
              duplicateADs={duplicateADs}
            />
          </div>
        )}

        {/* Submit Progress */}
        {rowStatuses.length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Processing Results</h2>
            <SubmitProgress
              statuses={rowStatuses}
              isRunning={isSubmitting}
              onExportResults={handleExportResults}
            />
          </div>
        )}
      </main>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AuthGuard>
      <DashboardContent />
    </AuthGuard>
  );
}
