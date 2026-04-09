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

/**
 * Determine which sheets are likely the main schedule sheets
 * (vs summary, rotation, breaks, etc.)
 */
export function identifyScheduleSheets(sheets: SheetData[]): SheetData[] {
  // Heuristics: schedule sheets have agent-level data
  return sheets.filter(sheet => {
    const name = sheet.sheetName.toLowerCase();

    // Definitely skip these
    if (['summary', 'rota', 'breaks', 'break patterns', 'totals',
         'raw interval data', 'old schedule model', 'leavers',
         'special shifts', 'nsa', 'idp', 'team split', 'time',
         'dailing slots for gb', 'base rotation'].includes(name)) {
      return false;
    }

    // Must have enough rows to contain agents (header + at least 2 agents)
    if (sheet.totalRows < 4) return false;

    // Look for agent-like data: check if any row has what looks like names
    const sample = sheet.rows.slice(0, 20);
    const hasNameLikeData = sample.some(row =>
      row.some(cell => {
        if (typeof cell !== 'string') return false;
        // Looks like a name: two+ words, first letter capitalized
        return /^[A-Z][a-z]+ [A-Z][a-z]+/.test(cell) ||
               /^[A-Z][a-z]+, [A-Z][a-z]+/.test(cell);
      })
    );

    return hasNameLikeData || sheet.totalRows > 10;
  });
}
