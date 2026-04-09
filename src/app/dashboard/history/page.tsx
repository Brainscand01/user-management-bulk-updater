'use client';

import { useEffect, useState } from 'react';
import AuthGuard from '@/components/AuthGuard';
import NavHeader from '@/components/NavHeader';
import { createClient } from '@/lib/supabase';

interface Batch {
  id: string;
  operation: string;
  file_name: string;
  total_records: number;
  successful: number;
  failed: number;
  status: string;
  processed_by: string;
  created_at: string;
  completed_at: string | null;
}

interface BatchRecord {
  id: string;
  row_number: number;
  employee_name: string;
  employee_code: string;
  operation: string;
  status: string;
  error_message: string | null;
  processed_at: string | null;
}

function HistoryContent() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [records, setRecords] = useState<BatchRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadBatches();
  }, []);

  async function loadBatches() {
    const supabase = createClient();
    const { data } = await supabase
      .from('batches')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    setBatches(data || []);
    setLoading(false);
  }

  async function loadRecords(batchId: string) {
    setSelectedBatch(batchId);
    const supabase = createClient();
    const { data } = await supabase
      .from('batch_records')
      .select('*')
      .eq('batch_id', batchId)
      .order('row_number', { ascending: true });
    setRecords(data || []);
  }

  const operationLabel = (op: string) => {
    switch (op) {
      case 'create': return 'Bulk Create';
      case 'update': return 'Bulk Update';
      case 'shift_update': return 'Shift Update';
      default: return op;
    }
  };

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      completed: 'bg-green-100 text-green-700',
      partial: 'bg-amber-100 text-amber-700',
      processing: 'bg-blue-100 text-blue-700',
      pending: 'bg-slate-100 text-slate-600',
      success: 'bg-green-100 text-green-700',
      failed: 'bg-red-100 text-red-700',
    };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status] || 'bg-slate-100 text-slate-600'}`}>
        {status}
      </span>
    );
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('en-ZA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <NavHeader />

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Batch List */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-sm font-medium text-slate-700 mb-4">Processing History</h2>

          {loading ? (
            <div className="text-sm text-slate-500">Loading...</div>
          ) : batches.length === 0 ? (
            <div className="text-sm text-slate-500">No batches processed yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Date</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Operation</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">File</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Records</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Success</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Failed</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Processed By</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600"></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map(batch => (
                    <tr
                      key={batch.id}
                      className={`border-t border-slate-100 ${selectedBatch === batch.id ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600">{formatDate(batch.created_at)}</td>
                      <td className="px-3 py-2">{operationLabel(batch.operation)}</td>
                      <td className="px-3 py-2 text-slate-500 max-w-[150px] truncate" title={batch.file_name}>
                        {batch.file_name}
                      </td>
                      <td className="px-3 py-2">{batch.total_records}</td>
                      <td className="px-3 py-2 text-green-600">{batch.successful}</td>
                      <td className="px-3 py-2 text-red-600">{batch.failed}</td>
                      <td className="px-3 py-2">{statusBadge(batch.status)}</td>
                      <td className="px-3 py-2 text-slate-500">{batch.processed_by}</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => loadRecords(batch.id)}
                          className="text-blue-600 hover:text-blue-800 text-xs font-medium"
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

        {/* Record Detail */}
        {selectedBatch && (
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Batch Records</h2>
            {records.length === 0 ? (
              <div className="text-sm text-slate-500">No records found.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50">
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Row</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Employee</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Code</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Error</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Processed At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(rec => (
                      <tr key={rec.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-slate-500">{rec.row_number}</td>
                        <td className="px-3 py-2">{rec.employee_name || '-'}</td>
                        <td className="px-3 py-2 text-slate-500">{rec.employee_code || '-'}</td>
                        <td className="px-3 py-2">{statusBadge(rec.status)}</td>
                        <td className="px-3 py-2 text-red-600 max-w-xs truncate" title={rec.error_message || ''}>
                          {rec.error_message || '-'}
                        </td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                          {rec.processed_at ? formatDate(rec.processed_at) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function HistoryPage() {
  return (
    <AuthGuard>
      <HistoryContent />
    </AuthGuard>
  );
}
