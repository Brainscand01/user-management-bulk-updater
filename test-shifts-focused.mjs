// Focused test: 5 representative files, 1 sheet each, long delays
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

const SHIFTS_DIR = 'C:/Users/Dfirma030/Downloads/International Shifts';
const API_KEY = fs.readFileSync('C:/Users/Dfirma030/Downloads/Claude Projects/ANTHROPIC_API_KEY.txt', 'utf-8').trim();

function excelTimeToString(fraction) {
  const totalMinutes = Math.round(fraction * 24 * 60);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function extractSheetData(buffer, maxRows = 120) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true });
  const results = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true, blankrows: false });
    const rows = [];
    const rowLimit = Math.min(rawRows.length, maxRows);
    for (let i = 0; i < rowLimit; i++) {
      const rawRow = rawRows[i];
      const cleaned = [];
      const colLimit = Math.min(rawRow.length, 30);
      for (let j = 0; j < colLimit; j++) {
        const cell = rawRow[j];
        if (cell === null || cell === undefined) { cleaned.push(null); }
        else if (typeof cell === 'boolean') { cleaned.push(cell ? 'TRUE' : 'FALSE'); }
        else if (typeof cell === 'number') {
          if (cell > 0 && cell < 1) cleaned.push(excelTimeToString(cell));
          else if (cell >= 1 && cell < 2) cleaned.push(excelTimeToString(cell % 1));
          else cleaned.push(cell);
        } else {
          const str = String(cell).trim();
          if (/^\d{4}-\d{2}-\d{2}T/.test(str)) cleaned.push(str.split('T')[0]);
          else cleaned.push(str || null);
        }
      }
      if (cleaned.some(c => c !== null)) rows.push(cleaned);
    }
    if (rows.length > 0) results.push({ sheetName, rows, totalRows, totalCols });
  }
  return results;
}

const SYSTEM_PROMPT = `You are a shift schedule data extractor. You receive raw cell data from Excel spreadsheet sheets containing employee shift schedules. Your job is to extract a clean, normalized list of shift assignments.

CRITICAL RULES:
1. Extract ONLY agent-level schedule data (individual people with their shift times per day)
2. Skip summary sheets, headcount pivots, rotation templates, and break schedules
3. For each agent on each working day, extract: agent name, AD/username/login, day of week, date, shift start time (SA time), shift end time (SA time)
4. Normalize ALL times to 24-hour HH:MM format in South African time (SAST/UTC+2)
5. If times appear to be in US timezones (EST/CST/PST), convert them to SA time by adding the appropriate offset:
   - EST (UTC-5): add 7 hours; CST (UTC-6): add 8 hours; PST (UTC-8): add 10 hours
6. If a day shows "OFF", "WO", "PTO", "AL", "VAC", "MED", "Vacation", "Day OFF" or similar, mark status as "off" or "leave" and leave times empty
7. If the AD/username is not present in this sheet, set ad to "" (empty string)
8. The AD format is typically: first letter of first name + abbreviated surname + 3 digits (e.g., "SMoodl108"). Other formats: "eNNNNNNN" (Earthlink E-ID)
9. Agent names may be "First Last", "Last, First", or "Full Name - AD - ID". Normalize to "First Last" format
10. If a sheet has IN/OFF pattern with separate SA Start/SA End columns, use those time columns for the actual shift times on "IN" days
11. Date: if actual dates are shown in headers, use them (YYYY-MM-DD). If only day names, use the week commencing date from context
12. Set confidence to "high" when all data is clear, "medium" when you had to infer something, "low" when guessing
13. If a sheet is clearly not an agent schedule, return an empty entries array with a skippedReason
14. IMPORTANT: Only return "working" entries. Skip all off/leave days to save space.
15. Keep response under 4000 tokens. If there are many agents, extract the first 30 only.

Return valid JSON only. No markdown, no code blocks, no explanation.`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function parseSheet(sheet, fileName) {
  const rows = sheet.rows.slice(0, 80);
  const grid = rows.map((row, i) =>
    `Row ${i}: ${row.map(c => c === null ? '' : String(c)).join(' | ')}`
  ).join('\n');

  const userPrompt = `File: "${fileName}"\nSheet: "${sheet.sheetName}"\nTotal rows: ${sheet.totalRows}, Total columns: ${sheet.totalCols}\n\nRaw cell data:\n${grid}\n\nExtract working agent shift assignments only. Return JSON with entries array. Max 30 agents.`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0,
      }),
    });

    if (res.status === 429) {
      const waitSecs = attempt * 30;
      console.log(`    Rate limited, waiting ${waitSecs}s (attempt ${attempt}/5)...`);
      await sleep(waitSecs * 1000);
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const textBlock = data.content?.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text in response');

    let jsonStr = textBlock.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    try {
      return JSON.parse(jsonStr);
    } catch {
      // Try salvaging truncated JSON
      const lastComplete = jsonStr.lastIndexOf('},');
      if (lastComplete > 0) {
        try { return JSON.parse(jsonStr.substring(0, lastComplete + 1) + ']}'); } catch {}
      }
      throw new Error('Invalid JSON in response');
    }
  }
  throw new Error('Max retries exceeded');
}

// 5 representative files + target sheets
const TEST_FILES = [
  { file: 'Pentius Schedule - 23 Mar\'26  29 Mar\'26.xlsx', sheet: '3.22', format: 'Simple flat + AD + free-text 12h times' },
  { file: 'Floorwalker Sup Coverage WC22.03.2026.xlsx', sheet: 'Floorwalker Sup covrage', format: 'Name-AD-ID combined + 24h times' },
  { file: 'ISAM Schedules WC23.03.2026.xlsx', sheet: 'WC 23.03', format: 'Rotation-based + IN/OFF + SA Start/End decimals + User AD' },
  { file: 'RV Schedules WC.23.03.2026 AD added.xlsx', sheet: 'SOE WC.23.03.2026', format: 'AD Logins + US/SA times + summary rows above' },
  { file: 'Ignition_Weekly_Schedules_Template WC 23.03.2026 2.xlsx', sheet: 'Sched_Hrs_Template.23,03,2026', format: 'Per-day sub-columns + ADs + Excel decimals' },
];

async function main() {
  console.log('=== FOCUSED SHIFT PARSER TEST ===\n');
  console.log(`Testing ${TEST_FILES.length} representative files, 1 sheet each\n`);

  for (const test of TEST_FILES) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`FILE: ${test.file}`);
    console.log(`SHEET: ${test.sheet}`);
    console.log(`FORMAT: ${test.format}`);
    console.log('='.repeat(80));

    const filePath = path.join(SHIFTS_DIR, test.file);
    const buffer = fs.readFileSync(filePath);
    const allSheets = extractSheetData(buffer);
    const targetSheet = allSheets.find(s => s.sheetName === test.sheet);

    if (!targetSheet) {
      console.log(`  ERROR: Sheet "${test.sheet}" not found. Available: ${allSheets.map(s => s.sheetName).join(', ')}`);
      continue;
    }

    console.log(`  Sheet size: ${targetSheet.totalRows}r × ${targetSheet.totalCols}c`);

    try {
      const result = await parseSheet(targetSheet, test.file);

      if (result.skippedReason) {
        console.log(`  SKIPPED: ${result.skippedReason}`);
        continue;
      }

      const entries = result.entries || [];
      const working = entries.filter(e => e.status === 'working');
      const withAD = working.filter(e => e.ad);
      const agents = new Set(working.map(e => e.ad || e.agentName));

      console.log(`\n  RESULTS:`);
      console.log(`  Total entries: ${entries.length}`);
      console.log(`  Working shifts: ${working.length}`);
      console.log(`  Unique agents: ${agents.size}`);
      console.log(`  With AD: ${withAD.length} (${agents.size > 0 ? Math.round(new Set(withAD.map(e => e.ad)).size / agents.size * 100) : 0}%)`);
      console.log(`  Confidence: high=${entries.filter(e=>e.confidence==='high').length} med=${entries.filter(e=>e.confidence==='medium').length} low=${entries.filter(e=>e.confidence==='low').length}`);

      console.log(`\n  SAMPLE (first 5 working entries):`);
      for (const e of working.slice(0, 5)) {
        console.log(`    ${e.agentName.padEnd(28)} AD: ${(e.ad||'-').padEnd(14)} ${e.day.padEnd(10)} ${e.date.padEnd(12)} ${e.startTime}-${e.endTime} [${e.confidence}] ${e.notes || ''}`);
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }

    // 60s between requests to stay under rate limits
    console.log('\n  Waiting 60s for rate limit...');
    await sleep(60000);
  }

  console.log('\n\n=== TEST COMPLETE ===\n');
}

main().catch(console.error);
