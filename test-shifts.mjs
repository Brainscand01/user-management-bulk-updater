// Test script: processes shift files through the extractor + Haiku API
// Run: node test-shifts.mjs

import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

const SHIFTS_DIR = 'C:/Users/Dfirma030/Downloads/International Shifts';
const API_KEY = fs.readFileSync('C:/Users/Dfirma030/Downloads/Claude Projects/ANTHROPIC_API_KEY.txt', 'utf-8').trim();

// Inline the extraction logic (can't import TS directly)
function excelTimeToString(fraction) {
  const totalMinutes = Math.round(fraction * 24 * 60);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function extractSheetData(buffer, maxRows = 200) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true });
  const results = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet['!ref']) continue;

    const range = XLSX.utils.decode_range(sheet['!ref']);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;

    const nameLower = sheetName.toLowerCase();
    if (['breaks', 'break patterns', 'raw interval data', 'old schedule model'].includes(nameLower)) continue;

    const rawRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1, defval: null, raw: true, blankrows: false,
    });

    const rows = [];
    const rowLimit = Math.min(rawRows.length, maxRows);

    for (let i = 0; i < rowLimit; i++) {
      const rawRow = rawRows[i];
      const cleaned = [];
      for (let j = 0; j < rawRow.length; j++) {
        const cell = rawRow[j];
        if (cell === null || cell === undefined) {
          cleaned.push(null);
        } else if (typeof cell === 'boolean') {
          cleaned.push(cell ? 'TRUE' : 'FALSE');
        } else if (typeof cell === 'number') {
          if (cell > 0 && cell < 1) {
            cleaned.push(excelTimeToString(cell));
          } else if (cell >= 1 && cell < 2) {
            cleaned.push(excelTimeToString(cell % 1));
          } else {
            cleaned.push(cell);
          }
        } else {
          const str = String(cell).trim();
          if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
            cleaned.push(str.split('T')[0]);
          } else {
            cleaned.push(str || null);
          }
        }
      }
      if (cleaned.some(c => c !== null)) {
        rows.push(cleaned);
      }
    }

    if (rows.length > 0) {
      results.push({ sheetName, rows, totalRows, totalCols });
    }
  }
  return results;
}

function identifyScheduleSheets(sheets) {
  return sheets.filter(sheet => {
    const name = sheet.sheetName.toLowerCase();
    if (['summary', 'rota', 'breaks', 'break patterns', 'totals',
         'raw interval data', 'old schedule model', 'leavers',
         'special shifts', 'nsa', 'idp', 'team split', 'time',
         'dailing slots for gb', 'base rotation'].includes(name)) {
      return false;
    }
    if (sheet.totalRows < 4) return false;
    const sample = sheet.rows.slice(0, 20);
    const hasNameLikeData = sample.some(row =>
      row.some(cell => {
        if (typeof cell !== 'string') return false;
        return /^[A-Z][a-z]+ [A-Z][a-z]+/.test(cell) ||
               /^[A-Z][a-z]+, [A-Z][a-z]+/.test(cell);
      })
    );
    return hasNameLikeData || sheet.totalRows > 10;
  });
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

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function parseSheet(sheet, fileName, retries = 3) {
  const rows = sheet.rows.slice(0, 150);
  const grid = rows.map((row, i) =>
    `Row ${i}: ${row.map(c => c === null ? '' : String(c)).join(' | ')}`
  ).join('\n');

  const userPrompt = `File: "${fileName}"
Sheet: "${sheet.sheetName}"
Total rows: ${sheet.totalRows}, Total columns: ${sheet.totalCols}

Raw cell data (first ${rows.length} rows, pipe-delimited):
${grid}

Extract all agent shift assignments from this sheet. Return JSON matching the schema.`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0,
      }),
    });

    if (res.status === 429) {
      const waitSecs = attempt * 20;
      console.log(`    Rate limited, waiting ${waitSecs}s (attempt ${attempt}/${retries})...`);
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

    return JSON.parse(jsonStr);
  }
  throw new Error('Max retries exceeded due to rate limiting');
}

// Main
async function main() {
  const files = fs.readdirSync(SHIFTS_DIR).filter(f => f.endsWith('.xlsx'));
  console.log(`\n=== SHIFT PARSER TEST REPORT ===`);
  console.log(`Testing ${files.length} files\n`);

  const report = [];
  let totalAgents = 0;
  let totalWorkingEntries = 0;
  let totalWithAD = 0;
  let totalLowConf = 0;
  let totalErrors = 0;

  for (const file of files) {
    console.log(`\n--- Processing: ${file} ---`);
    const filePath = path.join(SHIFTS_DIR, file);
    const buffer = fs.readFileSync(filePath);

    try {
      const allSheets = extractSheetData(buffer);
      const scheduleSheets = identifyScheduleSheets(allSheets);

      // Limit to 2 best sheets per file to control rate limits
      const sheetsToProcess = scheduleSheets.slice(0, 2);
      console.log(`  Sheets: ${allSheets.length} total, ${scheduleSheets.length} schedule, processing ${sheetsToProcess.length}`);

      let fileEntries = [];
      let fileErrors = [];

      for (const sheet of sheetsToProcess) {
        try {
          console.log(`  Parsing sheet: ${sheet.sheetName} (${sheet.totalRows}r × ${sheet.totalCols}c)...`);
          const result = await parseSheet(sheet, file);

          if (result.skippedReason) {
            console.log(`    Skipped: ${result.skippedReason}`);
          } else {
            const entries = result.entries || [];
            fileEntries.push(...entries);
            const working = entries.filter(e => e.status === 'working');
            const withAD = working.filter(e => e.ad);
            console.log(`    Extracted: ${entries.length} entries, ${working.length} working, ${withAD.length} with AD`);
          }

          // Rate limit: wait 15s between sheets
          await sleep(15000);
        } catch (err) {
          console.log(`    ERROR: ${err.message}`);
          fileErrors.push({ sheet: sheet.sheetName, error: err.message });
          totalErrors++;
        }
      }

      const working = fileEntries.filter(e => e.status === 'working');
      const withAD = working.filter(e => e.ad);
      const lowConf = fileEntries.filter(e => e.confidence === 'low' || e.confidence === 'medium');
      const agents = new Set(working.map(e => e.ad || e.agentName));

      totalAgents += agents.size;
      totalWorkingEntries += working.length;
      totalWithAD += withAD.length;
      totalLowConf += lowConf.length;

      report.push({
        file,
        sheetsTotal: allSheets.length,
        sheetsProcessed: sheetsToProcess.length,
        totalEntries: fileEntries.length,
        workingEntries: working.length,
        uniqueAgents: agents.size,
        withAD: withAD.length,
        lowConfidence: lowConf.length,
        errors: fileErrors,
        sampleEntries: working.slice(0, 3),
      });

      console.log(`  RESULT: ${agents.size} agents, ${working.length} working shifts, ${withAD.length} with AD, ${lowConf.length} low-conf`);

    } catch (err) {
      console.log(`  FILE ERROR: ${err.message}`);
      report.push({ file, error: err.message });
      totalErrors++;
    }

    // Rate limit between files - wait 15s
    await sleep(15000);
  }

  // Summary
  console.log(`\n\n========================================`);
  console.log(`          FINAL TEST REPORT`);
  console.log(`========================================`);
  console.log(`Files tested: ${files.length}`);
  console.log(`Total unique agents: ${totalAgents}`);
  console.log(`Total working shift entries: ${totalWorkingEntries}`);
  console.log(`Entries with AD: ${totalWithAD}`);
  console.log(`Low/medium confidence: ${totalLowConf}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`========================================\n`);

  // Per-file summary table
  console.log('FILE SUMMARY:');
  console.log('-'.repeat(120));
  console.log('File'.padEnd(55) + 'Agents'.padEnd(10) + 'Working'.padEnd(10) + 'With AD'.padEnd(10) + 'Low Conf'.padEnd(10) + 'Errors');
  console.log('-'.repeat(120));
  for (const r of report) {
    if (r.error) {
      console.log(`${r.file.padEnd(55)}ERROR: ${r.error}`);
    } else {
      console.log(`${r.file.slice(0, 54).padEnd(55)}${String(r.uniqueAgents).padEnd(10)}${String(r.workingEntries).padEnd(10)}${String(r.withAD).padEnd(10)}${String(r.lowConfidence).padEnd(10)}${r.errors.length}`);
    }
  }

  // Sample entries from each file
  console.log('\n\nSAMPLE ENTRIES (first 3 working per file):');
  console.log('-'.repeat(120));
  for (const r of report) {
    if (r.sampleEntries && r.sampleEntries.length > 0) {
      console.log(`\n${r.file}:`);
      for (const e of r.sampleEntries) {
        console.log(`  ${e.agentName.padEnd(25)} AD: ${(e.ad || '-').padEnd(12)} ${e.day.padEnd(10)} ${e.date.padEnd(12)} ${e.startTime}-${e.endTime} [${e.confidence}]`);
      }
    }
  }

  // Write full report to file
  fs.writeFileSync(
    path.join(SHIFTS_DIR, 'TEST_REPORT.json'),
    JSON.stringify(report, null, 2)
  );
  console.log(`\nFull report saved to: ${path.join(SHIFTS_DIR, 'TEST_REPORT.json')}`);
}

main().catch(console.error);
