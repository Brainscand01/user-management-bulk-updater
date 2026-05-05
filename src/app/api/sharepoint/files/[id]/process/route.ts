import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import { downloadFile } from '@/lib/sharepoint';
import { extractSheetData, identifyScheduleSheets } from '@/lib/shift-extractor';

// Up to 5 minutes per file. The route walks sheets sequentially via the
// existing /api/shifts/parse endpoint (one sheet per internal HTTP call)
// then aggregates via /api/shifts/finalize — same flow the manual upload uses.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

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

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function getOrigin(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (host) return `${proto}://${host}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

export async function POST(request: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const supabase = sb();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const body = await request.json().catch(() => ({})) as { actorEmail?: string };
    const actorEmail = body.actorEmail || null;

    // Look up the file row
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

    // Mark parsing
    await supabase
      .from('um_sharepoint_files')
      .update({ status: 'parsing', error_message: null })
      .eq('id', id);

    let parseId: string | null = null;
    let totalEntries = 0;
    let needsReview = 0;

    try {
      // Download buffer from Graph
      const buffer = await downloadFile(row.drive_id, row.graph_file_id);

      // Extract sheets
      const allSheets = extractSheetData(buffer);
      const scheduleSheets = identifyScheduleSheets(allSheets);
      const sheetsToParse = scheduleSheets.length > 0 ? scheduleSheets : allSheets;

      const origin = getOrigin(request);
      const accumulated: SheetResult[] = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCost = 0;

      // Sequential per-sheet calls to existing parse endpoint
      for (const sheet of sheetsToParse) {
        try {
          const res = await fetch(`${origin}/api/shifts/parse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileName: row.name,
              sheet,
              userEmail: actorEmail,
            }),
          });
          const text = await res.text();
          let data: { results?: SheetResult[]; usage?: { inputTokens: number; outputTokens: number; costUsd: number }; error?: string } = {};
          try { data = JSON.parse(text); } catch {
            accumulated.push({ sheetName: sheet.sheetName, entries: [], skippedReason: `Non-JSON response: ${text.slice(0, 80)}` });
            continue;
          }
          if (data.error || !data.results?.[0]) {
            accumulated.push({ sheetName: sheet.sheetName, entries: [], skippedReason: data.error || 'No result' });
            continue;
          }
          accumulated.push(data.results[0]);
          if (data.usage) {
            totalInputTokens += data.usage.inputTokens;
            totalOutputTokens += data.usage.outputTokens;
            totalCost += data.usage.costUsd;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          accumulated.push({ sheetName: sheet.sheetName, entries: [], skippedReason: msg });
        }
      }

      // Finalize — saves um_shift_parses + entries
      const finRes = await fetch(`${origin}/api/shifts/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: row.name,
          results: accumulated,
          totalInputTokens,
          totalOutputTokens,
          totalCost,
          userEmail: actorEmail,
        }),
      });

      const finText = await finRes.text();
      let finData: { parseId?: string; totalEntries?: number; needsReview?: number; error?: unknown } = {};
      try { finData = JSON.parse(finText); } catch { /* keep raw */ }

      if (!finRes.ok) {
        // Stringify the error properly — it might be a string, an object, or missing
        let errMsg: string;
        if (typeof finData.error === 'string') errMsg = finData.error;
        else if (finData.error && typeof finData.error === 'object') errMsg = JSON.stringify(finData.error);
        else if (finText) errMsg = finText.slice(0, 300);
        else errMsg = `HTTP ${finRes.status}`;
        throw new Error(`Finalize failed (${finRes.status}): ${errMsg}`);
      }
      parseId = finData.parseId ?? null;
      totalEntries = finData.totalEntries ?? 0;
      needsReview = finData.needsReview ?? 0;

      // Update file row → parsed
      await supabase
        .from('um_sharepoint_files')
        .update({
          status: 'parsed',
          parse_id: parseId,
          parsed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', id);

      await logAudit({
        actorEmail,
        action: 'sharepoint.file.parsed',
        entityType: 'sharepoint',
        entityId: id,
        summary: `Parsed ${row.name} from SharePoint — ${totalEntries} entries (${needsReview} need review)`,
        metadata: { fileName: row.name, parseId, totalEntries, needsReview },
      }, request);

      return NextResponse.json({ ok: true, parseId, totalEntries, needsReview });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await supabase
        .from('um_sharepoint_files')
        .update({ status: 'failed', error_message: message })
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
