'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { logAuditClient } from '@/lib/audit-client';

/**
 * Microsoft → Supabase OAuth landing page.
 *
 * Supabase JS auto-detects the auth code in the URL fragment / query and
 * exchanges it for a session via PKCE. We wait for the session to land,
 * then redirect to /dashboard.
 */
function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();

    const errCode = params.get('error');
    const errDesc = params.get('error_description');
    if (errCode) {
      const msg = errDesc || errCode;
      logAuditClient({
        action: 'login.failure',
        summary: `OAuth callback error: ${msg}`,
        metadata: { provider: 'azure', error: errCode, description: errDesc },
      });
      setError(msg);
      return;
    }

    let cancelled = false;

    async function complete() {
      for (let i = 0; i < 40 && !cancelled; i++) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          logAuditClient({
            actorEmail: session.user.email || null,
            action: 'login.success',
            entityType: 'user',
            entityId: session.user.email || session.user.id,
            summary: 'Signed in via Microsoft SSO',
            metadata: { provider: 'azure' },
          });
          router.replace('/dashboard');
          return;
        }
        await new Promise(r => setTimeout(r, 250));
      }
      if (!cancelled) setError('Could not establish a session. Please try signing in again.');
    }

    complete();
    return () => { cancelled = true; };
  }, [router, params]);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="w-full max-w-sm bg-white rounded-lg shadow-md p-8 text-center">
          <h1 className="text-base font-semibold text-slate-900">Sign-in failed</h1>
          <p className="mt-2 text-sm text-red-600 bg-red-50 border border-red-200 p-3 rounded">{error}</p>
          <button
            onClick={() => router.replace('/login')}
            className="mt-4 inline-flex items-center justify-center px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-50">
      <div className="text-center">
        <div className="animate-spin h-10 w-10 border-4 border-blue-500 border-t-transparent rounded-full mx-auto" />
        <p className="mt-4 text-sm text-slate-500">Signing you in…</p>
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-slate-50">
          <div className="animate-spin h-10 w-10 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      }
    >
      <CallbackInner />
    </Suspense>
  );
}
