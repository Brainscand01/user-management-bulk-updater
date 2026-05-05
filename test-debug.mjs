// Quick debug: parse one small file and dump raw response
import fs from 'fs';
import XLSX from 'xlsx';

const SHIFTS_DIR = 'C:/Users/Dfirma030/Downloads/International Shifts';
const API_KEY = fs.readFileSync('C:/Users/Dfirma030/Downloads/Claude Projects/ANTHROPIC_API_KEY.txt', 'utf-8').trim();

function excelTimeToString(fraction) {
  const totalMinutes = Math.round(fraction * 24 * 60);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const filePath = `${SHIFTS_DIR}/Pentius Schedule - 23 Mar'26  29 Mar'26.xlsx`;
const buffer = fs.readFileSync(filePath);
const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true });
const sheet = workbook.Sheets['3.22'];
const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true, blankrows: false });

const rows = rawRows.slice(0, 40).map(row => {
  return row.slice(0, 20).map(cell => {
    if (cell === null || cell === undefined) return null;
    if (typeof cell === 'number' && cell > 0 && cell < 1) return excelTimeToString(cell);
    if (typeof cell === 'number' && cell >= 1 && cell < 2) return excelTimeToString(cell % 1);
    const str = String(cell).trim();
    return str || null;
  });
});

const grid = rows.map((row, i) => `Row ${i}: ${row.map(c => c === null ? '' : String(c)).join(' | ')}`).join('\n');

const prompt = `File: "Pentius Schedule"\nSheet: "3.22"\nTotal rows: 35, Total columns: 19\n\nRaw cell data:\n${grid}\n\nExtract working agent shift assignments only. Return JSON with entries array. Max 30 agents.`;

const SYSTEM = `You are a shift schedule data extractor. Extract agent shift data from raw Excel cell data.
For each working agent on each day, return: agentName, ad, day, date, startTime, endTime, status ("working"), confidence, notes.
Normalize times to HH:MM 24h SAST. Agent AD is typically format like "SBishe483".
Return JSON: {"entries": [...]}. Only return working shifts (skip OFF/leave).
No markdown. No code blocks. Just JSON.`;

async function main() {
  console.log('Grid being sent:\n');
  console.log(grid.slice(0, 2000));
  console.log('\n---\n');

  for (let attempt = 1; attempt <= 8; attempt++) {
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
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
    });

    if (res.status === 429) {
      console.log(`Rate limited, waiting ${attempt * 30}s...`);
      await new Promise(r => setTimeout(r, attempt * 30000));
      continue;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || 'NO TEXT';
    console.log('RAW RESPONSE:\n');
    console.log(text.slice(0, 3000));
    console.log('\n\nStop reason:', data.stop_reason);
    console.log('Usage:', JSON.stringify(data.usage));

    // Try parsing
    try {
      let jsonStr = text.trim();
      if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(jsonStr);
      console.log('\nParsed entries:', parsed.entries?.length);
      if (parsed.entries?.[0]) {
        console.log('\nFirst entry:', JSON.stringify(parsed.entries[0], null, 2));
        console.log('\nSecond entry:', JSON.stringify(parsed.entries[1], null, 2));
      }
    } catch (e) {
      console.log('Parse error:', e.message);
    }
    return;
  }
}

main().catch(console.error);
