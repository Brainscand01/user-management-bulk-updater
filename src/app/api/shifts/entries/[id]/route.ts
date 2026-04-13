import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// params is a Promise in this Next.js version; must be awaited
type Ctx = { params: Promise<{ id: string }> };

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const supabase = sb();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }
  const { id } = await params;
  const body = await request.json() as {
    start_time?: string | null;
    end_time?: string | null;
    ad?: string | null;
    status?: string;
    confidence?: string;
    notes?: string | null;
    day?: string;
    date?: string | null;
    agent_name?: string;
  };

  // Only allow these fields through
  const patch: Record<string, unknown> = {};
  const allowed = ['start_time', 'end_time', 'ad', 'status', 'confidence', 'notes', 'day', 'date', 'agent_name'] as const;
  for (const k of allowed) {
    if (k in body) patch[k] = (body as Record<string, unknown>)[k];
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('um_shift_parse_entries')
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ entry: data });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const supabase = sb();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }
  const { id } = await params;
  const { error } = await supabase
    .from('um_shift_parse_entries')
    .delete()
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
