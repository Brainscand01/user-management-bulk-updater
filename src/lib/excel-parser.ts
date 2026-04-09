import * as XLSX from 'xlsx';

export type OperationType = 'create' | 'update' | 'shift_update';

export interface ParseResult {
  operation: OperationType;
  rows: Record<string, unknown>[];
  headers: string[];
  sheetName: string;
}

const CREATE_HEADERS = [
  'Name', 'Surname', 'IdNumber', 'AD', 'RoleId', 'ManagerUserId',
  'RegionId', 'CampaignId', 'JoinDate', 'IdType', 'ContactNumber',
  'EmployeeCode', 'JobTitle', 'UserStatusId', 'UserTypeId',
  'TerminationDate', 'TerminationReasonId', 'TerminationNotes',
  'Wave', 'Client', 'ExternalAD', 'UserFeatureIds', 'AgentShiftTimeId'
];

const UPDATE_HEADERS = ['UserId', ...CREATE_HEADERS];

const SHIFT_HEADERS = ['UserId', 'AgentShiftTimeId'];

function detectOperation(sheetName: string, headers: string[]): OperationType {
  const name = sheetName.toLowerCase();
  if (name.includes('shift')) return 'shift_update';
  if (name.includes('update')) return 'update';
  if (name.includes('create')) return 'create';

  // Fallback: detect by headers
  const hasUserId = headers.includes('UserId');
  const hasName = headers.includes('Name');

  if (hasUserId && !hasName) return 'shift_update';
  if (hasUserId && hasName) return 'update';
  return 'create';
}

function formatDate(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'number') {
    // Excel serial date number
    const date = XLSX.SSF.parse_date_code(value);
    if (date) {
      const y = date.y;
      const m = String(date.m).padStart(2, '0');
      const d = String(date.d).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  const str = String(value).trim();
  // Already in yyyy-MM-dd format
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // Try to parse other date formats
  const date = new Date(str);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }
  return str;
}

export function parseExcelFile(buffer: ArrayBuffer): ParseResult[] {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const results: ParseResult[] = [];

  for (const sheetName of workbook.SheetNames) {
    if (sheetName.toLowerCase() === 'fieldreference') continue;

    const sheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: true,
    });

    if (rawData.length === 0) continue;

    const headers = Object.keys(rawData[0]);
    const operation = detectOperation(sheetName, headers);

    // Clean and format rows
    const rows = rawData.map(row => {
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        const trimmedKey = key.trim();
        if (trimmedKey === 'JoinDate' || trimmedKey === 'TerminationDate') {
          cleaned[trimmedKey] = formatDate(value);
        } else if (trimmedKey === 'UserFeatureIds') {
          // Handle comma-separated IDs or array
          const str = String(value || '').trim();
          cleaned[trimmedKey] = str ? str.split(',').map(s => s.trim()).filter(Boolean) : [];
        } else {
          const str = String(value ?? '').trim();
          cleaned[trimmedKey] = str;
        }
      }
      return cleaned;
    });

    results.push({ operation, rows, headers, sheetName });
  }

  return results;
}

export function getExpectedHeaders(operation: OperationType): string[] {
  switch (operation) {
    case 'create': return CREATE_HEADERS;
    case 'update': return UPDATE_HEADERS;
    case 'shift_update': return SHIFT_HEADERS;
  }
}

// Build API request body from a parsed row
export function buildCreateBody(row: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const fields = [
    'Name', 'Surname', 'IdNumber', 'AD', 'RoleId', 'ManagerUserId',
    'RegionId', 'CampaignId', 'JoinDate', 'IdType', 'ContactNumber',
    'EmployeeCode', 'JobTitle', 'UserStatusId', 'UserTypeId',
    'TerminationDate', 'TerminationReasonId', 'TerminationNotes',
    'Wave', 'Client', 'ExternalAD'
  ];

  for (const field of fields) {
    const val = row[field];
    const str = String(val ?? '').trim();
    if (str) {
      body[field] = str;
    } else if (['TerminationDate', 'TerminationReasonId', 'TerminationNotes', 'Wave', 'Client', 'ExternalAD'].includes(field)) {
      body[field] = null;
    }
  }

  // UserFeatureIds
  const features = row['UserFeatureIds'];
  if (Array.isArray(features) && features.length > 0) {
    body['UserFeatureIds'] = features;
  } else {
    body['UserFeatureIds'] = [];
  }

  // AgentShiftTime (optional on create)
  const shiftId = String(row['AgentShiftTimeId'] || '').trim();
  if (shiftId) {
    body['AgentShiftTime'] = { AgentShiftTimeId: shiftId };
  }

  return body;
}

export function buildUpdateBody(row: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const fields = [
    'Name', 'Surname', 'IdNumber', 'AD', 'RoleId', 'ManagerUserId',
    'RegionId', 'CampaignId', 'JoinDate', 'IdType', 'ContactNumber',
    'EmployeeCode', 'JobTitle', 'UserStatusId', 'UserTypeId',
    'TerminationDate', 'TerminationReasonId', 'TerminationNotes',
    'Wave', 'Client', 'ExternalAD'
  ];

  for (const field of fields) {
    const val = row[field];
    const str = String(val ?? '').trim();
    if (str) {
      body[field] = str;
    }
  }

  // UserFeatureIds
  const features = row['UserFeatureIds'];
  if (Array.isArray(features) && features.length > 0) {
    body['UserFeatureIds'] = features;
  }

  // AgentShiftTime
  const shiftId = String(row['AgentShiftTimeId'] || '').trim();
  if (shiftId) {
    body['AgentShiftTime'] = { AgentShiftTimeId: shiftId };
  }

  return body;
}

export function buildShiftBody(row: Record<string, unknown>): Record<string, unknown> {
  return {
    AgentShiftTime: {
      AgentShiftTimeId: String(row['AgentShiftTimeId'] || '').trim()
    }
  };
}
