import * as XLSX from 'xlsx';

export interface SheetData {
  sheetName: string;
  rows: (string | number | null)[][];
  totalRows: number;
  totalCols: number;
}

export interface ShiftParseRequest {
  fileName: string;
  sheets: SheetData[];
}

/**
 * Extract raw cell data from all sheets of an Excel file.
 * Sends first N rows of each sheet for AI analysis.
 * Times stored as Excel serial numbers are converted to HH:MM strings.
 */
export function extractSheetData(buffer: ArrayBuffer, maxRows = 200): SheetData[] {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false, raw: true });
  const results: SheetData[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet['!ref']) continue;

    const range = XLSX.utils.decode_range(sheet['!ref']);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;

    // Skip clearly irrelevant sheets
    const nameLower = sheetName.toLowerCase();
    if (nameLower === 'sheet1' && workbook.SheetNames.length > 2) continue;
    if (['breaks', 'break patterns', 'raw interval data', 'old schedule model'].includes(nameLower)) continue;

    // Get raw data as arrays
    const rawRows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
      header: 1,
      defval: null,
      raw: true,
      blankrows: false,
    });

    // Process and clean rows - convert Excel time serials to readable times
    const rows: (string | number | null)[][] = [];
    const rowLimit = Math.min(rawRows.length, maxRows);

    for (let i = 0; i < rowLimit; i++) {
      const rawRow = rawRows[i];
      const cleaned: (string | number | null)[] = [];

      for (let j = 0; j < rawRow.length; j++) {
        const cell = rawRow[j];
        if (cell === null || cell === undefined) {
          cleaned.push(null);
        } else if (typeof cell === 'boolean') {
          cleaned.push(cell ? 'TRUE' : 'FALSE');
        } else if (typeof cell === 'number') {
          // Check if this looks like an Excel time serial (0 < x < 1)
          // or a date serial that's actually a time (around 1 = 1900-01-01)
          if (cell > 0 && cell < 1) {
            cleaned.push(excelTimeToString(cell));
          } else if (cell >= 1 && cell < 2) {
            // Could be 1.something which is date+time, extract time part
            cleaned.push(excelTimeToString(cell % 1));
          } else {
            cleaned.push(cell);
          }
        } else {
          const str = String(cell).trim();
          // Clean up date strings that are really dates in the header
          if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
            cleaned.push(str.split('T')[0]);
          } else {
            cleaned.push(str || null);
          }
        }
      }

      // Skip completely empty rows
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

function excelTimeToString(fraction: number): string {
  const totalMinutes = Math.round(fraction * 24 * 60);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Cap the number of schedule sheets we'll actually send to AI per file. A
// 49-sheet workbook is almost always 5-10 real schedule sheets plus 30+
// summary/template/lookup tabs. With streaming + 800s maxDuration we can
// fit ~10 sheets per invocation; anything beyond that is the long tail.
export const MAX_SCHEDULE_SHEETS_PER_FILE = 10;

// Sheet names we never want to parse — extend as new patterns appear.
const DENY_EXACT = new Set([
  'summary', 'rota', 'rotas', 'breaks', 'break patterns', 'totals',
  'raw interval data', 'old schedule model', 'leavers', 'special shifts',
  'nsa', 'idp', 'team split', 'time', 'dailing slots for gb',
  'base rotation', 'headcount', 'roster', 'roster summary', 'pivot',
  'pivots', 'lookups', 'lookup', 'reference', 'references', 'template',
  'templates', 'config', 'settings', 'meta', 'metadata', 'instructions',
  'readme', 'notes', 'cover', 'cover page', 'index', 'toc', 'contents',
  'team list', 'agent list', 'staff list', 'attendance', 'leave',
  'absence', 'pto', 'wfh', 'kpi', 'kpis', 'targets', 'forecast',
  'staffing', 'skills', 'skill matrix', 'rotations',
]);

const DENY_SUBSTRING = [
  'summary', 'pivot', 'rotation', 'breaks', 'break ', 'lookup',
  'template', 'headcount', 'roster summary', 'leave', 'attendance',
  'forecast', 'staffing', 'kpi', 'old ',
];

/**
 * Determine which sheets are likely the main schedule sheets and rank
 * them so the most-likely candidates come first. Caller will typically
 * limit to MAX_SCHEDULE_SHEETS_PER_FILE.
 */
export function identifyScheduleSheets(sheets: SheetData[]): SheetData[] {
  type Scored = { sheet: SheetData; score: number };
  const scored: Scored[] = [];

  for (const sheet of sheets) {
    const name = sheet.sheetName.trim();
    const nameLower = name.toLowerCase();

    // Hard-deny by exact match or substring
    if (DENY_EXACT.has(nameLower)) continue;
    if (DENY_SUBSTRING.some(s => nameLower.includes(s))) continue;

    // Sheets with default names like Sheet1, Sheet22 tend to be empties
    // or scratch tabs. Allow only if they have substantial data.
    const isDefaultName = /^sheet\d+$/i.test(name);
    if (isDefaultName && sheet.totalRows < 15) continue;

    // Need enough rows to plausibly hold a roster
    if (sheet.totalRows < 4) continue;

    // Score: prefer sheets with name-like cells, more rows, and meaningful names
    let score = 0;
    score += Math.min(sheet.totalRows, 100); // cap bonus from row count
    if (sheet.totalCols > 8) score += 20;     // wider sheets often = days × agents
    if (!isDefaultName) score += 30;           // named tabs beat Sheet1/Sheet9

    // Sample first 20 rows for human-name hints
    const sample = sheet.rows.slice(0, 20);
    const nameHits = sample.reduce((acc, row) => {
      for (const cell of row) {
        if (typeof cell !== 'string') continue;
        if (/^[A-Z][a-z]+ [A-Z][a-z]+/.test(cell) ||
            /^[A-Z][a-z]+, [A-Z][a-z]+/.test(cell)) {
          return acc + 1;
        }
      }
      return acc;
    }, 0);
    score += nameHits * 5;

    // Tab name signals — boost actual schedule indicators
    if (/(schedule|shift|wfm|roster|week|wc[\s_]?\d|w\d|w c)/i.test(name)) score += 25;

    // Hard floor: must have either name-like data OR 12+ rows + non-default name
    const passes = nameHits > 0 || (sheet.totalRows >= 12 && !isDefaultName);
    if (!passes) continue;

    scored.push({ sheet, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, MAX_SCHEDULE_SHEETS_PER_FILE)
    .map(s => s.sheet);
}
