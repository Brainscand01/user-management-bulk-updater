import { NextRequest, NextResponse } from 'next/server';

const PORTELO_BASE = 'https://portelo-api.webuildgreat.software/UserManagement';
const API_KEY = process.env.PORTELO_API_KEY;

export async function POST(request: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json(
      { isError: true, message: 'API key not configured' },
      { status: 500 }
    );
  }

  const userId = request.nextUrl.searchParams.get('UserId');
  if (!userId) {
    return NextResponse.json(
      { isError: true, message: 'UserId query parameter is required' },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();

    const res = await fetch(`${PORTELO_BASE}/user/updateUser?UserId=${userId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': API_KEY,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { isError: true, message: `Proxy error: ${message}` },
      { status: 500 }
    );
  }
}
