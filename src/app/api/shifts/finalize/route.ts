import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

interface ParsedShiftEntry {
  agentName: string;
  ad: string;
  day: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

interface SheetResult {
  sheetName: string;
  entries: ParsedShiftEntry[];
  skippedReason?: string;
}

export async function POST(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    const {
      fileName,
      results,
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      userEmail,
    } = await request.json() as {
      fileName: string;
      results: SheetResult[];
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCost: number;
      userEmail?: string;
    };

    const allEntries = results.flatMap(r => r.entries);
    const uniqueAgents = new Set(allEntries.map(e => e.ad || e.agentName)).size;
    const needsReview = allEntries.filter(e => e.confidence === 'low' || e.confidence === 'medium').length;
    const sheetsSkipped = results.filter(r => r.skippedReason).length;

    const { data: parseRow, error: insertErr } = await supabase
      .from('um_shift_parses')
      .insert({
        file_name: fileName,
        sheets_processed: results.length,
        sheets_skipped: sheetsSkipped,
        total_entries: allEntries.length,
        unique_agents: uniqueAgents,
        needs_review: needsReview,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cost_usd: totalCost,
        processed_by: userEmail || null,
      })
      .select('id')
      .single();

    if (insertErr || !parseRow) {
      return NextResponse.json({ error: insertErr?.message || 'Failed to save parse' }, { status: 500 });
    }

    const parseId = parseRow.id;

    // Flatten entries with their sheet name, then batch-insert
    const flatEntries: Array<ReturnType<typeof buildEntryRow>> = [];
    for (const r of results) {
      for (const e of r.entries) {
        flatEntries.push(buildEntryRow(parseId, r.sheetName, e));
      }
    }

    for (let b = 0; b < flatEntries.length; b += 100) {
      const batch = flatEntries.slice(b, b + 100);
      const { error } = await supabase.from('um_shift_parse_entries').insert(batch);
      if (error) {
        return NextResponse.json({ error: `Entry save failed: ${error.message}`, parseId }, { status: 500 });
      }
    }

    return NextResponse.json({
      parseId,
      totalEntries: allEntries.length,
      uniqueAgents,
      needsReview,
      sheetsSkipped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function buildEntryRow(parseId: string, sheetName: string, e: ParsedShiftEntry) {
  return {
    parse_id: parseId,
    sheet_name: sheetName,
    agent_name: e.agentName,
    ad: e.ad || null,
    day: e.day,
    date: e.date || null,
    start_time: e.startTime || null,
    end_time: e.endTime || null,
    status: e.status,
    confidence: e.confidence,
    notes: e.notes || null,
  };
}
