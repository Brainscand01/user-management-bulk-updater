'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DialogProvider } from '@/components/Dialog';

export interface SessionUser {
  email: string;
  name?: string;
  oid?: string;
  tid?: string;
}

async function fetchSession(): Promise<SessionUser | null> {
  try {
    const res = await fetch('/api/auth/session', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json() as { user: SessionUser | null };
    return data.user;
  } catch {
    return null;
  }
}

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSession().then(u => {
      if (!u) {
        router.replace('/login');
      } else {
        setUser(u);
      }
      setLoading(false);
    });
  }, [router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (!user) return null;

  return <DialogProvider>{children}</DialogProvider>;
}

export function useCurrentUser() {
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    fetchSession().then(setUser);
  }, []);

  return user;
}
