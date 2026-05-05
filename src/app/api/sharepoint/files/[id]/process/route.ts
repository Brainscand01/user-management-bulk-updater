import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import { downloadFile } from '@/lib/sharepoint';
import { extractSheetData, identifyScheduleSheets } from '@/lib/shift-extractor';
import { parseSheetWithAI, finalizeShifts, type SheetResult } from '@/lib/shift-parser-core';

// Up to 5 minutes per file (Vercel Pro). The route runs the full parse
// pipeline in-process — no internal HTTP hops, so deployment-protection
// 403s and double-billing are eliminated.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

export async function POST(request: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const supabase = sb();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
    }

    const body = await request.json().catch(() => ({})) as { actorEmail?: string };
    const actorEmail = body.actorEmail || null;

    const { data: row, error: rowErr } = await supabase
      .from('um_sharepoint_files')
      .select('*')
      .eq('id', id)
      .single();

    if (rowErr || !row) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if (row.status === 'parsing') {
      return NextResponse.json({ error: 'File is already being processed' }, { status: 409 });
    }

    // Helper to write progress without blocking (best-effort)
    const setProgress = async (
      step: string,
      extra: Partial<{ current: number; total: number; label: string }> = {}
    ) => {
      await supabase
        .from('um_sharepoint_files')
        .update({
          progress: { step, updated_at: new Date().toISOString(), ...extra },
        })
        .eq('id', id);
    };

    await supabase
      .from('um_sharepoint_files')
      .update({
        status: 'parsing',
        error_message: null,
        progress: { step: 'starting', updated_at: new Date().toISOString() },
      })
      .eq('id', id);

    try {
      // 1. Download from SharePoint
      await setProgress('downloading', { label: 'Downloading from SharePoint' });
      const buffer = await downloadFile(row.drive_id, row.graph_file_id);

      // 2. Extract sheets, prefer schedule-like ones
      await setProgress('extracting', { label: 'Reading Excel sheets' });
      const allSheets = extractSheetData(buffer);
      const scheduleSheets = identifyScheduleSheets(allSheets);
      const sheetsToParse = scheduleSheets.length > 0 ? scheduleSheets : allSheets;

      // 3. Run Claude on each sheet (sequential, paced)
      const client = new Anthropic({ apiKey });
      const accumulated: SheetResult[] = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCost = 0;

      for (let i = 0; i < sheetsToParse.length; i++) {
        await setProgress('parsing_sheet', {
          current: i + 1,
          total: sheetsToParse.length,
          label: sheetsToParse[i].sheetName,
        });
        const { result, usage } = await parseSheetWithAI(
          client,
          sheetsToParse[i],
          row.name,
          actorEmail,
          supabase,
        );
        accumulated.push(result);
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        totalCost += usage.costUsd;
        if (i < sheetsToParse.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // 4. Save aggregate to um_shift_parses + entries
      await setProgress('finalizing', { label: 'Saving entries' });
      const fin = await finalizeShifts(
        supabase,
        row.name,
        accumulated,
        { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd: totalCost },
        actorEmail,
      );

      // 5. Mark SharePoint row as parsed
      await supabase
        .from('um_sharepoint_files')
        .update({
          status: 'parsed',
          parse_id: fin.parseId,
          parsed_at: new Date().toISOString(),
          error_message: null,
          progress: { step: 'done', updated_at: new Date().toISOString() },
        })
        .eq('id', id);

      await logAudit({
        actorEmail,
        action: 'sharepoint.file.parsed',
        entityType: 'sharepoint',
        entityId: id,
        summary: `Parsed ${row.name} from SharePoint — ${fin.totalEntries} entries (${fin.needsReview} need review)`,
        metadata: {
          fileName: row.name,
          parseId: fin.parseId,
          totalEntries: fin.totalEntries,
          uniqueAgents: fin.uniqueAgents,
          needsReview: fin.needsReview,
          sheetsProcessed: accumulated.length,
          sheetsSkipped: fin.sheetsSkipped,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          costUsd: totalCost,
        },
      }, request);

      return NextResponse.json({
        ok: true,
        parseId: fin.parseId,
        totalEntries: fin.totalEntries,
        needsReview: fin.needsReview,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await supabase
        .from('um_sharepoint_files')
        .update({
          status: 'failed',
          error_message: message,
          progress: { step: 'failed', label: message.slice(0, 200), updated_at: new Date().toISOString() },
        })
        .eq('id', id);

      await logAudit({
        actorEmail,
        action: 'sharepoint.file.failed',
        entityType: 'sharepoint',
        entityId: id,
        summary: `Failed to parse ${row.name}: ${message}`,
        metadata: { fileName: row.name, error: message },
      }, request);

      return NextResponse.json({ error: message }, { status: 500 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
