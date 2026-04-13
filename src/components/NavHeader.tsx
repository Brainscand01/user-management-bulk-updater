'use client';

import { useRouter, usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { useCurrentUser } from '@/components/AuthGuard';
import { logAuditClient } from '@/lib/audit-client';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const iconClass = 'w-5 h-5 shrink-0';

const navItems: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Upload',
    icon: (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
      </svg>
    ),
  },
  {
    href: '/dashboard/shifts',
    label: 'Shift Parser',
    icon: (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/shifts/history',
    label: 'Shift History',
    icon: (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    href: '/dashboard/shifts/mappings',
    label: 'Shift Mappings',
    icon: (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h10M4 18h10M19 14l-3 3m0 0l3 3m-3-3h6" />
      </svg>
    ),
  },
  {
    href: '/dashboard/history',
    label: 'Upload History',
    icon: (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    href: '/dashboard/audit',
    label: 'Audit Log',
    icon: (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/admin',
    label: 'Admin',
    icon: (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

export default function NavHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const user = useCurrentUser();

  const handleSignOut = async () => {
    const supabase = createClient();
    logAuditClient({
      actorEmail: user?.email || null,
      action: 'logout',
      entityType: 'user',
      entityId: user?.email || null,
      summary: 'Signed out',
    });
    await supabase.auth.signOut();
    router.replace('/login');
  };

  return (
    <aside
      className="fixed left-0 top-0 h-screen w-60 flex flex-col text-[#E5F9F8]"
      style={{ backgroundColor: '#1F2B2D' }}
    >
      {/* Brand */}
      <div
        className="px-5 py-5 border-b"
        style={{ borderColor: 'rgba(229,249,248,0.08)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm"
            style={{ backgroundColor: '#0D8A9E', color: '#E5F9F8' }}
          >
            UM
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">UM Bulk</div>
            <div className="text-[10px] leading-tight opacity-60">Updater</div>
          </div>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map(item => {
          const isActive = pathname === item.href;
          return (
            <button
              key={item.href}
              onClick={() => router.push(item.href)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-md transition-colors group"
              style={{
                backgroundColor: isActive ? '#23717B' : 'transparent',
                color: isActive ? '#E5F9F8' : 'rgba(229,249,248,0.7)',
              }}
              onMouseEnter={e => {
                if (!isActive) {
                  e.currentTarget.style.backgroundColor = 'rgba(13,138,158,0.15)';
                  e.currentTarget.style.color = '#E5F9F8';
                }
              }}
              onMouseLeave={e => {
                if (!isActive) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = 'rgba(229,249,248,0.7)';
                }
              }}
            >
              <span style={{ color: isActive ? '#E5F9F8' : '#0D8A9E' }}>
                {item.icon}
              </span>
              <span className="font-medium">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* User + sign out */}
      <div
        className="px-3 py-3 border-t"
        style={{ borderColor: 'rgba(229,249,248,0.08)' }}
      >
        <div className="px-2 mb-2">
          <div className="text-[10px] uppercase tracking-wider opacity-50">Signed in</div>
          <div
            className="text-xs font-medium truncate"
            title={user?.email || ''}
          >
            {user?.email || '—'}
          </div>
        </div>
        <button
          onClick={handleSignOut}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-md transition-colors"
          style={{ color: 'rgba(229,249,248,0.7)' }}
          onMouseEnter={e => {
            e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.15)';
            e.currentTarget.style.color = '#fca5a5';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.color = 'rgba(229,249,248,0.7)';
          }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Sign out
        </button>
      </div>
    </aside>
  );
}
