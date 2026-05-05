'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase';
import { logAuditClient } from '@/lib/audit-client';

export default function LoginPage() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleMicrosoftSignIn() {
    setError('');
    setLoading(true);

    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback`;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        scopes: 'openid profile email',
        redirectTo,
      },
    });

    if (error) {
      logAuditClient({
        action: 'login.failure',
        entityType: 'user',
        summary: `Microsoft sign-in failed: ${error.message}`,
        metadata: { reason: error.message, provider: 'azure' },
      });
      setError(error.message);
      setLoading(false);
    }
    // On success, browser is redirected away — no further action here.
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-50">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-md p-8">
        <div className="text-center mb-8">
          <div
            className="w-12 h-12 mx-auto mb-3 rounded-lg flex items-center justify-center font-bold text-base text-white"
            style={{ backgroundColor: '#0D8A9E' }}
          >
            UM
          </div>
          <h1 className="text-2xl font-bold text-slate-900">UM Bulk Updater</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in with your Ignition account</p>
        </div>

        <button
          onClick={handleMicrosoftSignIn}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 py-2.5 px-4 bg-white border border-slate-300 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <span className="inline-block animate-spin h-4 w-4 border-2 border-slate-400 border-t-transparent rounded-full" />
          ) : (
            <svg className="w-5 h-5" viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg">
              <rect x="1" y="1" width="10" height="10" fill="#F25022" />
              <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
              <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
              <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
            </svg>
          )}
          {loading ? 'Redirecting…' : 'Sign in with Microsoft'}
        </button>

        {error && (
          <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 p-2 rounded">
            {error}
          </div>
        )}

        <p className="mt-6 text-[11px] text-center text-slate-400">
          Authorized Ignition staff only · Powered by Microsoft Entra ID
        </p>
      </div>
    </div>
  );
}
