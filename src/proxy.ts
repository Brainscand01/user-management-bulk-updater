import { NextResponse, type NextRequest } from 'next/server';
import { verifySession, SESSION_CONFIG } from '@/lib/session';

/**
 * Edge-runtime middleware (renamed to proxy in Next 16). Protects every
 * /dashboard/* route by verifying the session cookie. Unauthenticated
 * requests are bounced to /login with the original path captured in ?next=.
 */
export async function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_CONFIG.cookieName)?.value;
  if (token) {
    const user = await verifySession(token);
    if (user) return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  const target = new URL('/login', request.url);
  target.searchParams.set('next', url.pathname + url.search);
  return NextResponse.redirect(target);
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
