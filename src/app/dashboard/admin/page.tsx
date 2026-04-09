'use client';

import { useEffect, useState } from 'react';
import AuthGuard from '@/components/AuthGuard';
import NavHeader from '@/components/NavHeader';

interface AppUser {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
}

function AdminContent() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add user form
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState('');

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/users');
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setUsers(data.users || []);
      }
    } catch {
      setError('Failed to load users');
    }
    setLoading(false);
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setAddError('');
    setAddSuccess('');
    setAdding(true);

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, password: newPassword }),
      });
      const data = await res.json();

      if (data.error) {
        setAddError(data.error);
      } else {
        setAddSuccess(`User ${newEmail} created successfully`);
        setNewEmail('');
        setNewPassword('');
        loadUsers();
      }
    } catch {
      setAddError('Failed to create user');
    }
    setAdding(false);
  }

  async function handleDeleteUser(userId: string, email: string) {
    if (!confirm(`Are you sure you want to delete ${email}? This cannot be undone.`)) {
      return;
    }

    try {
      const res = await fetch('/api/admin/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();

      if (data.error) {
        alert(`Failed to delete: ${data.error}`);
      } else {
        loadUsers();
      }
    } catch {
      alert('Failed to delete user');
    }
  }

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString('en-ZA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <NavHeader />

      <main className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        {/* Add User Form */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-sm font-medium text-slate-700 mb-4">Add New User</h2>

          <form onSubmit={handleAddUser} className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
              <input
                type="email"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                required
                placeholder="user@company.com"
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                required
                minLength={6}
                placeholder="Min 6 characters"
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <button
              type="submit"
              disabled={adding}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {adding ? 'Adding...' : 'Add User'}
            </button>
          </form>

          {addError && (
            <div className="mt-3 text-sm text-red-600 bg-red-50 p-2 rounded">{addError}</div>
          )}
          {addSuccess && (
            <div className="mt-3 text-sm text-green-600 bg-green-50 p-2 rounded">{addSuccess}</div>
          )}
        </div>

        {/* User List */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-sm font-medium text-slate-700 mb-4">
            Users ({users.length})
          </h2>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 p-3 rounded mb-4">
              {error}
              {error.includes('Service') && (
                <p className="mt-1 text-xs text-red-500">
                  Set the SUPABASE_SERVICE_ROLE_KEY environment variable in Vercel to enable admin features.
                </p>
              )}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-slate-500">Loading users...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Email</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Created</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Last Sign In</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Confirmed</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600"></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium">{u.email}</td>
                      <td className="px-3 py-2 text-slate-500">{formatDate(u.created_at)}</td>
                      <td className="px-3 py-2 text-slate-500">{formatDate(u.last_sign_in_at)}</td>
                      <td className="px-3 py-2">
                        {u.email_confirmed_at ? (
                          <span className="text-green-600 text-xs font-medium">Yes</span>
                        ) : (
                          <span className="text-amber-600 text-xs font-medium">No</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => handleDeleteUser(u.id, u.email || '')}
                          className="text-xs text-red-500 hover:text-red-700 transition-colors"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function AdminPage() {
  return (
    <AuthGuard>
      <AdminContent />
    </AuthGuard>
  );
}
