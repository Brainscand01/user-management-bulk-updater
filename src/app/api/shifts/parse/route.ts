import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import {
  parseSheetWithAI,
  finalizeShifts,
  calculateCost,
  type SheetPayload,
  type SheetResult,
} from '@/lib/shift-parser-core';

// Up to 5 minutes per sheet (Pro). Hobby caps at 60s — single sheet calls stay under.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
    }

    const body = await request.json() as {
      fileName: string;
      sheets?: SheetPayload[];
      sheet?: SheetPayload;
      userEmail?: string;
    };
    const { fileName, userEmail } = body;

    // Support BOTH legacy multi-sheet mode AND the per-sheet flow used by the queue
    const sheets: SheetPayload[] = body.sheet ? [body.sheet] : (body.sheets || []);
    const singleSheetMode = !!body.sheet;

    if (!sheets || sheets.length === 0) {
      return NextResponse.json({ error: 'No sheet data provided' }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

    const client = new Anthropic({ apiKey });
    const results: SheetResult[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let i = 0; i < sheets.length; i++) {
      const { result, usage } = await parseSheetWithAI(client, sheets[i], fileName, userEmail || null, supabase);
      results.push(result);
      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
      if (i < sheets.length - 1) {
        await new Promise(r => setTimeout(r, 2000)); // pace rate limits
      }
    }

    const allEntries = results.flatMap(r => r.entries);
    const totalCost = calculateCost(totalInputTokens, totalOutputTokens);
    const uniqueAgents = new Set(allEntries.map(e => e.ad || e.agentName)).size;
    const needsReview = allEntries.filter(e => e.confidence === 'low' || e.confidence === 'medium').length;
    const sheetsSkipped = results.filter(r => r.skippedReason).length;

    let parseId: string | null = null;
    if (supabase && !singleSheetMode) {
      try {
        const fin = await finalizeShifts(
          supabase,
          fileName,
          results,
          { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd: totalCost },
          userEmail || null,
        );
        parseId = fin.parseId;
      } catch {
        // Non-critical; results returned even if save fails
      }
    }

    return NextResponse.json({
      results,
      parseId,
      totalEntries: allEntries.length,
      totalAgents: uniqueAgents,
      sheetsProcessed: results.length,
      sheetsSkipped,
      needsReview,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd: totalCost,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
