import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';

export const maxDuration = 60;

interface IncomingMapping {
  shift_id: string;
  start_time?: string;
  end_time?: string;
  label?: string;
  campaign?: string;
  notes?: string;
  active?: boolean;
}

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = sb();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const body = await request.json() as {
      rows: IncomingMapping[];
      actorEmail?: string | null;
      deactivateMissing?: boolean;
    };

    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return NextResponse.json({ error: 'rows array required' }, { status: 400 });
    }

    // Normalize
    const rows = body.rows
      .filter(r => r && r.shift_id)
      .map(r => {
        const start = (r.start_time || '').trim();
        const end = (r.end_time || '').trim();
        const label = (r.label || (start && end ? `${start} - ${end}` : '')).trim();
        return {
          shift_id: r.shift_id.trim(),
          start_time: start || null,
          end_time: end || null,
          label: label || r.shift_id,
          campaign: r.campaign?.trim() || null,
          notes: r.notes?.trim() || null,
          active: r.active !== false,
          updated_at: new Date().toISOString(),
          updated_by: body.actorEmail || null,
        };
      });

    // Fetch existing for diff
    const ids = rows.map(r => r.shift_id);
    const { data: existing } = await supabase
      .from('um_shift_mappings')
      .select('shift_id, start_time, end_time, label, active')
      .in('shift_id', ids);

    const existingMap = new Map((existing || []).map(e => [e.shift_id, e]));

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const changedIds: string[] = [];

    for (const r of rows) {
      const ex = existingMap.get(r.shift_id);
      if (!ex) inserted++;
      else if (
        ex.start_time !== r.start_time ||
        ex.end_time !== r.end_time ||
        ex.label !== r.label ||
        ex.active !== r.active
      ) {
        updated++;
        changedIds.push(r.shift_id);
      } else {
        unchanged++;
      }
    }

    // Batch upsert — 200 per batch for safety
    for (let b = 0; b < rows.length; b += 200) {
      const batch = rows.slice(b, b + 200);
      const { error } = await supabase
        .from('um_shift_mappings')
        .upsert(batch, { onConflict: 'shift_id' });
      if (error) {
        return NextResponse.json({ error: `Upsert failed: ${error.message}` }, { status: 500 });
      }
    }

    let deactivated = 0;
    if (body.deactivateMissing) {
      // Set active=false for any mapping not in the uploaded set
      const { data: all } = await supabase
        .from('um_shift_mappings')
        .select('shift_id')
        .eq('active', true);
      const incoming = new Set(ids);
      const toDeactivate = (all || [])
        .map(x => x.shift_id)
        .filter(sid => !incoming.has(sid));
      if (toDeactivate.length > 0) {
        const { error } = await supabase
          .from('um_shift_mappings')
          .update({ active: false, updated_at: new Date().toISOString(), updated_by: body.actorEmail || null })
          .in('shift_id', toDeactivate);
        if (!error) deactivated = toDeactivate.length;
      }
    }

    await logAudit({
      actorEmail: body.actorEmail,
      action: 'shift_mapping.upload',
      entityType: 'shift_mapping',
      summary: `Shift mappings upload: +${inserted} new, ~${updated} changed, ${unchanged} unchanged${deactivated ? `, ${deactivated} deactivated` : ''}`,
      metadata: {
        totalIncoming: rows.length,
        inserted,
        updated,
        unchanged,
        deactivated,
        changedIds: changedIds.slice(0, 100),
        deactivateMissing: !!body.deactivateMissing,
      },
    }, request);

    return NextResponse.json({ inserted, updated, unchanged, deactivated, total: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
