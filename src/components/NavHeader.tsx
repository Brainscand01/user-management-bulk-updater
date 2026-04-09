'use client';

import { useRouter, usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { useCurrentUser } from '@/components/AuthGuard';

const navItems = [
  { href: '/dashboard', label: 'Upload' },
  { href: '/dashboard/history', label: 'Audit Log' },
  { href: '/dashboard/admin', label: 'Admin' },
];

export default function NavHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const user = useCurrentUser();

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/login');
  };

  return (
    <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <h1 className="text-lg font-bold text-slate-900">UM Bulk Updater</h1>
        <nav className="flex items-center gap-1">
          {navItems.map(item => {
            const isActive = pathname === item.href;
            return (
              <button
                key={item.href}
                onClick={() => router.push(item.href)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  isActive
                    ? 'bg-blue-50 text-blue-700 font-medium'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
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
  );
}
