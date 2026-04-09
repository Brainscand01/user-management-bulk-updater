import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

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
  status: string; // "working", "off", "leave", "unknown"
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
6. If a day shows "OFF", "WO", "PTO", "AL", "VAC", "MED", "Vacation", "Day OFF" or similar, mark status as "off" or "leave" and leave times empty
7. If the AD/username is not present in this sheet, set ad to "" (empty string)
8. The AD format is typically: first letter of first name + abbreviated surname + 3 digits (e.g., "SMoodl108", "JJohns102"). Other formats: "eNNNNNNN" (Earthlink E-ID)
9. Agent names may be "First Last", "Last, First", or "Full Name - AD - ID". Normalize to "First Last" format
10. If a sheet has IN/OFF pattern with separate SA Start/SA End columns, use those time columns for the actual shift times on "IN" days
11. Date: if actual dates are shown in headers, use them (YYYY-MM-DD). If only day names, use the week commencing date from context
12. Set confidence to "high" when all data is clear, "medium" when you had to infer something, "low" when guessing
13. If a sheet is clearly not an agent schedule (summary, rotation template, break pattern), return an empty entries array with a skippedReason

Return valid JSON only. No markdown, no explanation outside JSON.`;

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    entries: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          agentName: { type: 'string' as const },
          ad: { type: 'string' as const },
          day: { type: 'string' as const, enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] },
          date: { type: 'string' as const },
          startTime: { type: 'string' as const },
          endTime: { type: 'string' as const },
          status: { type: 'string' as const, enum: ['working', 'off', 'leave', 'unknown'] },
          confidence: { type: 'string' as const, enum: ['high', 'medium', 'low'] },
          notes: { type: 'string' as const },
        },
        required: ['agentName', 'ad', 'day', 'date', 'startTime', 'endTime', 'status', 'confidence', 'notes'],
      },
    },
    skippedReason: { type: 'string' as const },
  },
  required: ['entries'],
};

function buildSheetPrompt(sheet: SheetPayload, fileName: string): string {
  // Truncate rows to fit in context - send up to 150 rows
  const rows = sheet.rows.slice(0, 150);

  // Format as readable text grid
  const grid = rows.map((row, i) =>
    `Row ${i}: ${row.map(c => c === null ? '' : String(c)).join(' | ')}`
  ).join('\n');

  return `File: "${fileName}"
Sheet: "${sheet.sheetName}"
Total rows: ${sheet.totalRows}, Total columns: ${sheet.totalCols}

Raw cell data (first ${rows.length} rows, pipe-delimited):
${grid}

Extract all agent shift assignments from this sheet. Return JSON matching the schema.`;
}

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY not configured' },
        { status: 500 }
      );
    }

    const { fileName, sheets } = await request.json() as {
      fileName: string;
      sheets: SheetPayload[];
    };

    if (!sheets || sheets.length === 0) {
      return NextResponse.json({ error: 'No sheet data provided' }, { status: 400 });
    }

    const client = new Anthropic({ apiKey });
    const results: SheetResult[] = [];

    // Process sheets sequentially to manage rate limits
    for (const sheet of sheets) {
      try {
        const userPrompt = buildSheetPrompt(sheet, fileName);

        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
          // Force JSON output
          temperature: 0,
        });

        // Extract text response
        const textBlock = response.content.find(b => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
          results.push({
            sheetName: sheet.sheetName,
            entries: [],
            skippedReason: 'No response from AI',
          });
          continue;
        }

        // Parse JSON from response - handle markdown code blocks
        let jsonStr = textBlock.text.trim();
        if (jsonStr.startsWith('```')) {
          jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }

        const parsed = JSON.parse(jsonStr) as { entries: ParsedShiftEntry[]; skippedReason?: string };

        // Validate and clean entries
        const validEntries = (parsed.entries || []).filter(e =>
          e.agentName && e.day && (e.status === 'off' || e.status === 'leave' || e.startTime)
        );

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
    }

    // Aggregate all entries across sheets
    const allEntries = results.flatMap(r => r.entries);

    return NextResponse.json({
      results,
      totalEntries: allEntries.length,
      totalAgents: new Set(allEntries.map(e => e.ad || e.agentName)).size,
      sheetsProcessed: results.length,
      sheetsSkipped: results.filter(r => r.skippedReason).length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
