import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const HAIKU_INPUT_COST_PER_M = 1.0;   // $1.00 per 1M input tokens
const HAIKU_OUTPUT_COST_PER_M = 5.0;  // $5.00 per 1M output tokens

function calculateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M +
         (outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;
}

interface SheetPayload {
  sheetName: string;
  rows: (string | number | null)[][];
  totalRows: number;
  totalCols: number;
}

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

const SYSTEM_PROMPT = `You are a shift schedule data extractor. You receive raw cell data from Excel spreadsheet sheets containing employee shift schedules. Your job is to extract a clean, normalized list of shift assignments.

CRITICAL RULES:
1. Extract ONLY agent-level schedule data (individual people with their shift times per day)
2. Skip summary sheets, headcount pivots, rotation templates, and break schedules
3. For each agent on each working day, extract: agent name, AD/username/login, day of week, date, shift start time (SA time), shift end time (SA time)
4. Normalize ALL times to 24-hour HH:MM format in South African time (SAST/UTC+2)
5. If times appear to be in US timezones (EST/CST/PST), convert them to SA time by adding the appropriate offset:
   - EST (UTC-5): add 7 hours
   - CST (UTC-6): add 8 hours
   - PST (UTC-8): add 10 hours
   Look for clues: column headers like "SA Time", "SA Start", "SAST", or if the file mentions US client names with separate SA time columns
6. ONLY return working shifts. Skip all OFF/leave/PTO/AL/VAC/MED/WO days entirely.
7. If the AD/username is not present in this sheet, set ad to "" (empty string)
8. The AD format is typically: first letter of first name + abbreviated surname + 3 digits (e.g., "SMoodl108", "JJohns102"). Other formats: "eNNNNNNN" (Earthlink E-ID)
9. Agent names may be "First Last", "Last, First", or "Full Name - AD - ID". Normalize to "First Last" format
10. If a sheet has IN/OFF pattern with separate SA Start/SA End columns, use those time columns for the actual shift times on "IN" days
11. Date: if actual dates are shown in headers, use them (YYYY-MM-DD). If only day names, use the week commencing date from context
12. AM/PM DISAMBIGUATION — VERY IMPORTANT:
    - Source times may appear as "4:00 - 1:00", "5:00 - 2:00" etc. with NO AM/PM marker
    - A plausible BPO shift is 6-12 hours long. A 4am-to-1am shift would be 21 hours — that's almost certainly 16:00-01:00
    - If the naive 24h reading gives a duration > 14 hours or < 4 hours, the start is very likely PM: add 12 to the start hour (4:00 → 16:00, 5:00 → 17:00, 6:00 → 18:00)
    - If times cross midnight (end < start numerically), that's fine — e.g., "17:00 - 02:00" is a valid 9-hour evening shift
    - Most SA agents supporting US clients work evening/overnight shifts (14:00-02:00, 16:00-01:00, 17:00-02:00 are very common). Default to PM interpretation when ambiguous start times are between 1:00 and 9:00 AND end times suggest the shift crosses into early morning
    - When you make a PM adjustment, set confidence to "medium" and add a note like "AM/PM inferred from shift length"

EXACT OUTPUT FORMAT - you MUST use these exact values:
- day: MUST be one of exactly: "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday" (full names, not abbreviations)
- status: MUST be exactly "working" (since you're only returning working shifts)
- confidence: MUST be exactly one of: "high", "medium", "low" (as a string, NOT a number)
- startTime and endTime: MUST be "HH:MM" 24-hour format strings
- date: MUST be "YYYY-MM-DD" format

If a sheet is clearly not an agent schedule (summary, rotation template, break pattern), return: {"entries": [], "skippedReason": "reason here"}

Return valid JSON only. No markdown code blocks. No explanation. Just the raw JSON object.`;

const DAY_MAP: Record<string, string> = {
  'mon': 'Monday', 'monday': 'Monday',
  'tue': 'Tuesday', 'tues': 'Tuesday', 'tuesday': 'Tuesday',
  'wed': 'Wednesday', 'wednesday': 'Wednesday',
  'thu': 'Thursday', 'thur': 'Thursday', 'thurs': 'Thursday', 'thursday': 'Thursday',
  'fri': 'Friday', 'friday': 'Friday',
  'sat': 'Saturday', 'saturday': 'Saturday',
  'sun': 'Sunday', 'sunday': 'Sunday',
};

function normalizeDayName(day: string): string {
  if (!day) return '';
  const mapped = DAY_MAP[day.toLowerCase().trim()];
  return mapped || day;
}

// Convert "HH:MM" to minutes since midnight, or null if invalid
function timeToMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Compute shift duration in minutes, handling overnight (end < start means wraps midnight)
function shiftDuration(startMin: number, endMin: number): number {
  return endMin >= startMin ? endMin - startMin : (1440 - startMin) + endMin;
}

// If a shift duration is implausibly long (>14h) or short (<2h), try adjusting
// the start time by adding 12h (AM→PM). Returns adjusted entry with confidence
// bumped to medium and a note. Leaves entry unchanged if adjustment doesn't help.
function sanityCheckShiftTimes(e: ParsedShiftEntry): ParsedShiftEntry {
  if (e.status !== 'working') return e;
  const startMin = timeToMinutes(e.startTime);
  const endMin = timeToMinutes(e.endTime);
  if (startMin === null || endMin === null) return e;

  const duration = shiftDuration(startMin, endMin);
  const durationHours = duration / 60;

  // Plausible shift: 2-14 hours. Outside that, try AM→PM flip on start
  if (durationHours >= 2 && durationHours <= 14) return e;

  // Try adding 12h to start (AM → PM)
  const flippedStart = (startMin + 12 * 60) % 1440;
  const flippedDuration = shiftDuration(flippedStart, endMin) / 60;

  if (flippedDuration >= 2 && flippedDuration <= 14) {
    const existingNote = e.notes ? `${e.notes}; ` : '';
    return {
      ...e,
      startTime: minutesToTime(flippedStart),
      confidence: e.confidence === 'high' ? 'medium' : e.confidence,
      notes: `${existingNote}Start time adjusted from ${e.startTime} to ${minutesToTime(flippedStart)} (original duration ${durationHours.toFixed(1)}h implausible)`,
    };
  }

  // Neither works — flag for review, keep original
  return {
    ...e,
    confidence: 'low',
    notes: e.notes ? `${e.notes}; Implausible duration ${durationHours.toFixed(1)}h` : `Implausible duration ${durationHours.toFixed(1)}h`,
  };
}

function buildSheetPrompt(sheet: SheetPayload, fileName: string): string {
  // Limit columns for very wide sheets - take first 30 meaningful columns
  const maxCols = 30;
  const rows = sheet.rows.slice(0, 120).map(row => {
    if (row.length > maxCols) {
      return row.slice(0, maxCols);
    }
    return row;
  });

  const grid = rows.map((row, i) =>
    `Row ${i}: ${row.map(c => c === null ? '' : String(c)).join(' | ')}`
  ).join('\n');

  return `File: "${fileName}"
Sheet: "${sheet.sheetName}"
Total rows: ${sheet.totalRows}, Total columns: ${sheet.totalCols}

Raw cell data (first ${rows.length} rows, pipe-delimited):
${grid}

Extract all agent shift assignments from this sheet. Return JSON matching the schema. Focus on working shifts only if there are many agents.`;
}

interface ApiCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function callWithRetry(
  client: Anthropic,
  prompt: string,
  maxRetries = 3,
): Promise<ApiCallResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 16384,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });

      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('No text in response');
      }

      return {
        text: textBlock.text,
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
      };
    } catch (err) {
      const isRateLimit = err instanceof Anthropic.RateLimitError ||
        (err instanceof Error && err.message.includes('429'));

      if (isRateLimit && attempt < maxRetries) {
        const waitMs = attempt * 15000; // 15s, 30s, 45s
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

function parseJsonResponse(text: string): { entries: ParsedShiftEntry[]; skippedReason?: string } {
  let jsonStr = text.trim();

  // Strip markdown code blocks
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  // Try to parse directly
  try {
    return JSON.parse(jsonStr);
  } catch {
    // If JSON is truncated, try to salvage partial data
    // Find the last complete entry by looking for the last "},"
    const lastComplete = jsonStr.lastIndexOf('},');
    if (lastComplete > 0) {
      const truncated = jsonStr.substring(0, lastComplete + 1) + ']}';
      try {
        return JSON.parse(truncated);
      } catch {
        // Try wrapping
        try {
          return JSON.parse(truncated + '}');
        } catch {
          // Give up
        }
      }
    }
    return { entries: [], skippedReason: 'Failed to parse AI response as JSON' };
  }
}

// Allow up to 5 minutes per sheet (Pro). Hobby caps at 60s — single sheet calls stay under.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY not configured' },
        { status: 500 }
      );
    }

    const body = await request.json() as {
      fileName: string;
      sheets?: SheetPayload[];
      sheet?: SheetPayload;
      userEmail?: string;
    };
    const { fileName, userEmail } = body;

    // Support BOTH legacy multi-sheet mode AND new single-sheet mode
    const sheets: SheetPayload[] = body.sheet ? [body.sheet] : (body.sheets || []);
    const singleSheetMode = !!body.sheet;

    if (!sheets || sheets.length === 0) {
      return NextResponse.json({ error: 'No sheet data provided' }, { status: 400 });
    }

    // Supabase client for usage logging
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const supabase = supabaseUrl && supabaseKey
      ? createClient(supabaseUrl, supabaseKey)
      : null;

    const client = new Anthropic({ apiKey });
    const results: SheetResult[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let i = 0; i < sheets.length; i++) {
      const sheet = sheets[i];

      try {
        const userPrompt = buildSheetPrompt(sheet, fileName);
        const apiResult = await callWithRetry(client, userPrompt);
        const parsed = parseJsonResponse(apiResult.text);

        // Track tokens
        totalInputTokens += apiResult.inputTokens;
        totalOutputTokens += apiResult.outputTokens;

        // Log usage to Supabase
        if (supabase) {
          const cost = calculateCost(apiResult.inputTokens, apiResult.outputTokens);
          await supabase.from('um_api_usage').insert({
            file_name: fileName,
            sheet_name: sheet.sheetName,
            input_tokens: apiResult.inputTokens,
            output_tokens: apiResult.outputTokens,
            cost_usd: cost,
            model: 'claude-haiku-4-5',
            user_email: userEmail || null,
          }).then(() => {}); // fire and forget
        }

        // Normalize and validate entries
        const validEntries = (parsed.entries || [])
          .map(e => ({
            ...e,
            // Normalize day abbreviations to full names
            day: normalizeDayName(e.day),
            // Ensure confidence is a string
            confidence: typeof e.confidence === 'number'
              ? (e.confidence >= 0.8 ? 'high' : e.confidence >= 0.5 ? 'medium' : 'low')
              : (e.confidence || 'medium'),
            // Default status to working if has times
            status: e.status || (e.startTime ? 'working' : 'off'),
          }))
          .filter(e => e.agentName && e.day && e.startTime)
          // Run server-side sanity check on shift durations
          .map(e => sanityCheckShiftTimes(e as ParsedShiftEntry));

        results.push({
          sheetName: sheet.sheetName,
          entries: validEntries,
          skippedReason: parsed.skippedReason,
        });
      } catch (sheetErr) {
        const msg = sheetErr instanceof Error ? sheetErr.message : 'Unknown error';
        results.push({
          sheetName: sheet.sheetName,
          entries: [],
          skippedReason: `Parse error: ${msg}`,
        });
      }

      // Pause between sheets to respect rate limits
      if (i < sheets.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const allEntries = results.flatMap(r => r.entries);
    const totalCost = calculateCost(totalInputTokens, totalOutputTokens);
    const uniqueAgents = new Set(allEntries.map(e => e.ad || e.agentName)).size;
    const needsReview = allEntries.filter(e => e.confidence === 'low' || e.confidence === 'medium').length;
    const sheetsSkipped = results.filter(r => r.skippedReason).length;

    // Skip DB save when called in single-sheet mode — client will call /api/shifts/finalize
    // after processing all sheets
    let parseId: string | null = null;
    if (supabase && !singleSheetMode) {
      try {
        const { data: parseRow } = await supabase
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

        if (parseRow) {
          parseId = parseRow.id;

          // Insert entries in batches of 100
          for (let b = 0; b < allEntries.length; b += 100) {
            const batch = allEntries.slice(b, b + 100).map((e, idx) => {
              // Find which sheet this entry came from
              let sheetName = '';
              let count = 0;
              for (const r of results) {
                if (b + idx < count + r.entries.length) {
                  sheetName = r.sheetName;
                  break;
                }
                count += r.entries.length;
              }
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
            });
            await supabase.from('um_shift_parse_entries').insert(batch);
          }
        }
      } catch {
        // Non-critical — don't fail the response if save fails
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
