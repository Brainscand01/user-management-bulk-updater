/**
 * Core shift-parser logic shared by both:
 *   - POST /api/shifts/parse        (browser-driven manual upload)
 *   - POST /api/sharepoint/files/[id]/process  (server-driven SharePoint sync)
 *
 * No HTTP hops between serverless functions — both routes import these
 * functions directly. This avoids Vercel deployment-protection 403s on
 * internal fetches and reduces invocation count.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';

// Haiku 4.5 list pricing (USD per 1M tokens) and cache modifiers:
//   - cache write  = 1.25x base input price
//   - cache read   = 0.10x base input price (90% off)
export const HAIKU_INPUT_COST_PER_M = 1.0;
export const HAIKU_OUTPUT_COST_PER_M = 5.0;
export const HAIKU_CACHE_WRITE_MULT = 1.25;
export const HAIKU_CACHE_READ_MULT = 0.10;
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Backwards-compatible cost calc for the simple uncached path.
 * Prefer calculateCostWithCache when cache_creation/cache_read tokens
 * are available from the API response.
 */
export function calculateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M +
         (outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;
}

export function calculateCostWithCache(
  uncachedInput: number,
  cacheCreation: number,
  cacheRead: number,
  outputTokens: number,
): number {
  return (
    (uncachedInput / 1_000_000) * HAIKU_INPUT_COST_PER_M +
    (cacheCreation / 1_000_000) * HAIKU_INPUT_COST_PER_M * HAIKU_CACHE_WRITE_MULT +
    (cacheRead / 1_000_000) * HAIKU_INPUT_COST_PER_M * HAIKU_CACHE_READ_MULT +
    (outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M
  );
}

export interface SheetPayload {
  sheetName: string;
  rows: (string | number | null)[][];
  totalRows: number;
  totalCols: number;
}

export interface ParsedShiftEntry {
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

export interface SheetResult {
  sheetName: string;
  entries: ParsedShiftEntry[];
  skippedReason?: string;
}

export interface SheetUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
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

Return valid JSON only. No markdown code blocks. No explanation. Just the raw JSON object.

CONCRETE EXAMPLES (study these — they cover the formats you will see most often):

Example 1 — vertical roster with agent names down column A and dates across the top:
Input rows:
  Row 0: Agent | Mon 2026-03-09 | Tue 2026-03-10 | Wed 2026-03-11 | Thu 2026-03-12 | Fri 2026-03-13
  Row 1: SMoodl108 - Sarah Moodley | 16:00-01:00 | 16:00-01:00 | OFF | 16:00-01:00 | 16:00-01:00
  Row 2: JJohns102 - John Johnson | 14:00-23:00 | 14:00-23:00 | 14:00-23:00 | OFF | OFF
Expected output:
  {"entries":[
    {"agentName":"Sarah Moodley","ad":"SMoodl108","day":"Monday","date":"2026-03-09","startTime":"16:00","endTime":"01:00","status":"working","confidence":"high","notes":""},
    {"agentName":"Sarah Moodley","ad":"SMoodl108","day":"Tuesday","date":"2026-03-10","startTime":"16:00","endTime":"01:00","status":"working","confidence":"high","notes":""},
    {"agentName":"Sarah Moodley","ad":"SMoodl108","day":"Thursday","date":"2026-03-12","startTime":"16:00","endTime":"01:00","status":"working","confidence":"high","notes":""},
    {"agentName":"Sarah Moodley","ad":"SMoodl108","day":"Friday","date":"2026-03-13","startTime":"16:00","endTime":"01:00","status":"working","confidence":"high","notes":""},
    {"agentName":"John Johnson","ad":"JJohns102","day":"Monday","date":"2026-03-09","startTime":"14:00","endTime":"23:00","status":"working","confidence":"high","notes":""},
    {"agentName":"John Johnson","ad":"JJohns102","day":"Tuesday","date":"2026-03-10","startTime":"14:00","endTime":"23:00","status":"working","confidence":"high","notes":""},
    {"agentName":"John Johnson","ad":"JJohns102","day":"Wednesday","date":"2026-03-11","startTime":"14:00","endTime":"23:00","status":"working","confidence":"high","notes":""}
  ]}
Note: OFF days are entirely skipped (rule 6). AD usernames extracted from the "AD - Full Name" pattern (rule 8).

Example 2 — IN/OFF marker with separate SA Start / SA End columns:
Input rows:
  Row 0: Name | AD | Mon | SA Start | SA End | Tue | SA Start | SA End | Wed | SA Start | SA End
  Row 1: Mary Smith | MSmith201 | IN | 17:00 | 02:00 | IN | 17:00 | 02:00 | OFF | | |
Expected output:
  {"entries":[
    {"agentName":"Mary Smith","ad":"MSmith201","day":"Monday","date":"","startTime":"17:00","endTime":"02:00","status":"working","confidence":"high","notes":""},
    {"agentName":"Mary Smith","ad":"MSmith201","day":"Tuesday","date":"","startTime":"17:00","endTime":"02:00","status":"working","confidence":"high","notes":""}
  ]}
Note: When IN appears, use the adjacent SA Start / SA End for the actual times (rule 10). OFF row skipped.

Example 3 — US-time source with explicit SA Time column:
Input rows:
  Row 0: Agent | EST Start | EST End | SA Start | SA End | Day
  Row 1: Robert Jones - eN1234567 | 09:00 | 18:00 | 16:00 | 01:00 | Monday
Expected output:
  {"entries":[
    {"agentName":"Robert Jones","ad":"eN1234567","day":"Monday","date":"","startTime":"16:00","endTime":"01:00","status":"working","confidence":"high","notes":""}
  ]}
Note: Use the SA columns directly when present (rule 5).

Example 4 — implausible AM/PM that needs flipping:
Input rows:
  Row 0: Agent | Monday | Tuesday | Wednesday
  Row 1: Lerato Khumalo | 4:00 - 1:00 | 4:00 - 1:00 | OFF
Expected output:
  {"entries":[
    {"agentName":"Lerato Khumalo","ad":"","day":"Monday","date":"","startTime":"16:00","endTime":"01:00","status":"working","confidence":"medium","notes":"Start time adjusted from 04:00 to 16:00 (original duration 21h implausible)"},
    {"agentName":"Lerato Khumalo","ad":"","day":"Tuesday","date":"","startTime":"16:00","endTime":"01:00","status":"working","confidence":"medium","notes":"Start time adjusted from 04:00 to 16:00 (original duration 21h implausible)"}
  ]}
Note: 4am-to-1am is 21h — implausible. Start was AM-marked, almost certainly meant 16:00 (rule 12). AD is empty when not provided (rule 7).

Example 5 — non-schedule sheet (skip):
Input rows:
  Row 0: Campaign | Required Heads | Forecast | Variance
  Row 1: Aptive | 25 | 23 | -2
  Row 2: Brock | 18 | 18 | 0
Expected output:
  {"entries":[],"skippedReason":"Headcount summary, not an agent schedule"}

Example 6 — date in header but day name elsewhere:
Input rows:
  Row 0: | | Week commencing 2026-04-21 | | | |
  Row 1: AD | Name | Mon | Tue | Wed | Thu | Fri
  Row 2: APatel104 | Aisha Patel | 08:00-17:00 | 08:00-17:00 | 08:00-17:00 | 08:00-17:00 | OFF
Expected output:
  {"entries":[
    {"agentName":"Aisha Patel","ad":"APatel104","day":"Monday","date":"2026-04-21","startTime":"08:00","endTime":"17:00","status":"working","confidence":"high","notes":""},
    {"agentName":"Aisha Patel","ad":"APatel104","day":"Tuesday","date":"2026-04-22","startTime":"08:00","endTime":"17:00","status":"working","confidence":"high","notes":""},
    {"agentName":"Aisha Patel","ad":"APatel104","day":"Wednesday","date":"2026-04-23","startTime":"08:00","endTime":"17:00","status":"working","confidence":"high","notes":""},
    {"agentName":"Aisha Patel","ad":"APatel104","day":"Thursday","date":"2026-04-24","startTime":"08:00","endTime":"17:00","status":"working","confidence":"high","notes":""}
  ]}
Note: Week-commencing 2026-04-21 is Monday. Increment dates by day-of-week column position (rule 11).

EDGE CASES TO HANDLE GRACEFULLY:
- Cells with merged-cell artifacts (repeated values across multiple columns) — use position-based logic
- Time written as "0900-1800" without colons → treat as 09:00-18:00
- Time written as "9-6" (single digit) → assume PM end if range is unreasonably short, e.g. "9-6" likely means 09:00-18:00
- Lower-case AD usernames (smoodl108) — preserve case as given by source
- Names with hyphens, apostrophes, accents (O'Brien, Müller, Khumalo-Ngcobo) — keep them intact
- Agent rows interspersed with blank or sub-header rows — skip blanks but keep parsing the rest
- "WFH", "REMOTE", "OFFICE" markers next to times — ignore them, use the times
- Multi-line shifts e.g. "08:00-13:00 / 14:00-19:00" → emit ONE working entry covering 08:00-19:00 with confidence=medium and notes mentioning the split
- A row that's clearly a totals/subtotal row (Total, Subtotal, %, Σ, blank-name with numbers) → skip
- Sheets that are mostly empty cells or headers only → return {"entries":[],"skippedReason":"insufficient data"}

Always prefer extracting MORE entries with confidence=medium over silently dropping data. The reviewer can fix medium-confidence entries; they cannot recover entries that were never extracted.`;

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

function shiftDuration(startMin: number, endMin: number): number {
  return endMin >= startMin ? endMin - startMin : (1440 - startMin) + endMin;
}

function sanityCheckShiftTimes(e: ParsedShiftEntry): ParsedShiftEntry {
  if (e.status !== 'working') return e;
  const startMin = timeToMinutes(e.startTime);
  const endMin = timeToMinutes(e.endTime);
  if (startMin === null || endMin === null) return e;
  const duration = shiftDuration(startMin, endMin);
  const durationHours = duration / 60;
  if (durationHours >= 2 && durationHours <= 14) return e;
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
  return {
    ...e,
    confidence: 'low',
    notes: e.notes ? `${e.notes}; Implausible duration ${durationHours.toFixed(1)}h` : `Implausible duration ${durationHours.toFixed(1)}h`,
  };
}

function buildSheetPrompt(sheet: SheetPayload, fileName: string): string {
  const maxCols = 30;
  const rows = sheet.rows.slice(0, 120).map(row =>
    row.length > maxCols ? row.slice(0, maxCols) : row
  );
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
  uncachedInputTokens: number;     // input tokens charged at full rate
  cacheCreationTokens: number;     // input tokens written to cache (1.25x rate)
  cacheReadTokens: number;         // input tokens served from cache (0.10x rate)
  outputTokens: number;
}

async function callWithRetry(
  client: Anthropic,
  prompt: string,
  maxRetries = 3,
): Promise<ApiCallResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // STREAM the response. Anthropic's non-streaming endpoint caps
      // max_tokens at ~16k for Haiku 4.5; on capped sheets the JSON gets
      // truncated and we silently lose data. Streaming has no such cap so
      // the model can emit the full 32k of agents on a big sheet.
      const stream = client.messages.stream({
        model: HAIKU_MODEL,
        max_tokens: 32_000,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });

      // SDK v0.87 doesn't expose a `.textStream` getter — iterate the
      // raw event stream and accumulate text deltas ourselves.
      let text = '';
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text;
        }
      }
      const finalMessage = await stream.finalMessage();

      const usage = finalMessage.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      } | undefined;

      if (!text) throw new Error('Empty stream — no text emitted');

      return {
        text,
        uncachedInputTokens: usage?.input_tokens || 0,
        cacheCreationTokens: usage?.cache_creation_input_tokens || 0,
        cacheReadTokens: usage?.cache_read_input_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
      };
    } catch (err) {
      const isRateLimit = err instanceof Anthropic.RateLimitError ||
        (err instanceof Error && err.message.includes('429'));
      if (isRateLimit && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, attempt * 15000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

function parseJsonResponse(text: string): { entries: ParsedShiftEntry[]; skippedReason?: string } {
  let jsonStr = text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  try { return JSON.parse(jsonStr); }
  catch {
    const lastComplete = jsonStr.lastIndexOf('},');
    if (lastComplete > 0) {
      const truncated = jsonStr.substring(0, lastComplete + 1) + ']}';
      try { return JSON.parse(truncated); }
      catch {
        try { return JSON.parse(truncated + '}'); }
        catch { /* give up */ }
      }
    }
    return { entries: [], skippedReason: 'Failed to parse AI response as JSON' };
  }
}

/**
 * Parse a single sheet via Claude Haiku. Returns the cleaned entries,
 * skip reason (if any), and token/cost usage. Logs to um_api_usage.
 *
 * Pure function over (client, sheet, fileName, userEmail) — no HTTP, no
 * route handler ceremony.
 */
export async function parseSheetWithAI(
  client: Anthropic,
  sheet: SheetPayload,
  fileName: string,
  userEmail: string | null,
  supabase: SupabaseClient | null,
): Promise<{ result: SheetResult; usage: SheetUsage }> {
  try {
    const prompt = buildSheetPrompt(sheet, fileName);
    const apiResult = await callWithRetry(client, prompt);
    const parsed = parseJsonResponse(apiResult.text);

    const totalInput =
      apiResult.uncachedInputTokens +
      apiResult.cacheCreationTokens +
      apiResult.cacheReadTokens;
    const cost = calculateCostWithCache(
      apiResult.uncachedInputTokens,
      apiResult.cacheCreationTokens,
      apiResult.cacheReadTokens,
      apiResult.outputTokens,
    );
    if (supabase) {
      // Fire-and-forget usage log — input_tokens stores the SUM (uncached +
      // cache-create + cache-read) so historical reports stay coherent;
      // detailed breakdown lives in metadata.
      supabase.from('um_api_usage').insert({
        file_name: fileName,
        sheet_name: sheet.sheetName,
        input_tokens: totalInput,
        output_tokens: apiResult.outputTokens,
        cost_usd: cost,
        model: 'claude-haiku-4-5',
        user_email: userEmail || null,
      }).then(() => {});
    }

    const validEntries = (parsed.entries || [])
      .map(e => ({
        ...e,
        day: normalizeDayName(e.day),
        confidence: typeof e.confidence === 'number'
          ? (e.confidence >= 0.8 ? 'high' : e.confidence >= 0.5 ? 'medium' : 'low')
          : (e.confidence || 'medium'),
        status: e.status || (e.startTime ? 'working' : 'off'),
      }))
      .filter(e => e.agentName && e.day && e.startTime)
      .map(e => sanityCheckShiftTimes(e as ParsedShiftEntry));

    return {
      result: {
        sheetName: sheet.sheetName,
        entries: validEntries,
        skippedReason: parsed.skippedReason,
      },
      usage: {
        inputTokens: totalInput,
        outputTokens: apiResult.outputTokens,
        costUsd: cost,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    // Surface in Vercel logs so we don't have to inspect 'sheets_skipped'
    // counts to discover that every call is throwing.
    console.error(`[parseSheetWithAI] sheet="${sheet.sheetName}" file="${fileName}" — ${msg}`);
    return {
      result: { sheetName: sheet.sheetName, entries: [], skippedReason: `Parse error: ${msg}` },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }
}

/**
 * Save aggregated parse results to um_shift_parses + um_shift_parse_entries.
 * Throws on database error so callers see the real cause.
 */
export async function finalizeShifts(
  supabase: SupabaseClient,
  fileName: string,
  results: SheetResult[],
  totals: { inputTokens: number; outputTokens: number; costUsd: number },
  userEmail: string | null,
): Promise<{ parseId: string; totalEntries: number; uniqueAgents: number; needsReview: number; sheetsSkipped: number }> {
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
      input_tokens: totals.inputTokens,
      output_tokens: totals.outputTokens,
      cost_usd: totals.costUsd,
      processed_by: userEmail || null,
    })
    .select('id')
    .single();

  if (insertErr || !parseRow) {
    throw new Error(`Failed to insert parse summary: ${insertErr?.message || 'unknown'}`);
  }
  const parseId = parseRow.id as string;

  // Build flat entries with sheet name attached
  const flatEntries: Array<Record<string, unknown>> = [];
  for (const r of results) {
    for (const e of r.entries) {
      flatEntries.push({
        parse_id: parseId,
        sheet_name: r.sheetName,
        agent_name: e.agentName,
        ad: e.ad || null,
        day: e.day,
        date: e.date || null,
        start_time: e.startTime || null,
        end_time: e.endTime || null,
        status: e.status,
        confidence: e.confidence,
        notes: e.notes || null,
      });
    }
  }

  for (let b = 0; b < flatEntries.length; b += 100) {
    const batch = flatEntries.slice(b, b + 100);
    const { error } = await supabase.from('um_shift_parse_entries').insert(batch);
    if (error) {
      throw new Error(`Failed to insert entries (batch ${b / 100}): ${error.message}`);
    }
  }

  return { parseId, totalEntries: allEntries.length, uniqueAgents, needsReview, sheetsSkipped };
}
