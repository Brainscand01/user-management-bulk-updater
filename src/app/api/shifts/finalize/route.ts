import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import { finalizeShifts, type SheetResult } from '@/lib/shift-parser-core';

export const maxDuration = 60;

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

    const fin = await finalizeShifts(
      supabase,
      fileName,
      results,
      { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd: totalCost },
      userEmail || null,
    );

    await logAudit({
      actorEmail: userEmail,
      action: 'shift.parse',
      entityType: 'shift_parse',
      entityId: fin.parseId,
      summary: `Parsed ${fileName} — ${fin.totalEntries} entries, ${fin.uniqueAgents} agents (${fin.needsReview} need review)`,
      metadata: {
        fileName,
        sheetsProcessed: results.length,
        sheetsSkipped: fin.sheetsSkipped,
        totalEntries: fin.totalEntries,
        uniqueAgents: fin.uniqueAgents,
        needsReview: fin.needsReview,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd: totalCost,
      },
    }, request);

    return NextResponse.json({
      parseId: fin.parseId,
      totalEntries: fin.totalEntries,
      uniqueAgents: fin.uniqueAgents,
      needsReview: fin.needsReview,
      sheetsSkipped: fin.sheetsSkipped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
