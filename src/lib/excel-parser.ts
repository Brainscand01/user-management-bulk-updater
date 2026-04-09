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

// Map common column name variations to canonical names
const HEADER_ALIASES: Record<string, string> = {
  // Case variations
  'idnumber': 'IdNumber',
  'id number': 'IdNumber',
  'id_number': 'IdNumber',
  'campaignid': 'CampaignId',
  'campaign id': 'CampaignId',
  'campaign_id': 'CampaignId',
  'externalad': 'ExternalAD',
  'external ad': 'ExternalAD',
  'external_ad': 'ExternalAD',
  'roleid': 'RoleId',
  'role id': 'RoleId',
  'manageruserid': 'ManagerUserId',
  'manager user id': 'ManagerUserId',
  'regionid': 'RegionId',
  'region id': 'RegionId',
  'joindate': 'JoinDate',
  'join date': 'JoinDate',
  'terminationdate': 'TerminationDate',
  'termination date': 'TerminationDate',
  'terminationreasonid': 'TerminationReasonId',
  'termination reason id': 'TerminationReasonId',
  'idtype': 'IdType',
  'id type': 'IdType',
  'contactnumber': 'ContactNumber',
  'contact number': 'ContactNumber',
  'employeecode': 'EmployeeCode',
  'employee code': 'EmployeeCode',
  'jobtitle': 'JobTitle',
  'job title': 'JobTitle',
  'userstatusid': 'UserStatusId',
  'user status id': 'UserStatusId',
  'usertypeid': 'UserTypeId',
  'user type id': 'UserTypeId',
  'userfeatureids': 'UserFeatureIds',
  'user feature ids': 'UserFeatureIds',
  'terminationnotes': 'TerminationNotes',
  'termination notes': 'TerminationNotes',
  'agentshifttimeid': 'AgentShiftTimeId',
  'agent shift time id': 'AgentShiftTimeId',
  'userid': 'UserId',
  'user id': 'UserId',
  'name': 'Name',
  'surname': 'Surname',
  'ad': 'AD',
  'wave': 'Wave',
  'client': 'Client',
};

function normalizeHeader(header: string): string {
  const trimmed = header.trim();
  // Check exact match first (case-sensitive)
  if (CREATE_HEADERS.includes(trimmed) || trimmed === 'UserId') {
    return trimmed;
  }
  // Check alias map (case-insensitive)
  const lower = trimmed.toLowerCase();
  if (HEADER_ALIASES[lower]) {
    return HEADER_ALIASES[lower];
  }
  // Return original if no match
  return trimmed;
}

function detectOperation(sheetName: string, headers: string[]): OperationType {
  const name = sheetName.toLowerCase();
  if (name.includes('shift')) return 'shift_update';
  if (name.includes('update')) return 'update';
  if (name.includes('create')) return 'create';

  // Fallback: detect by normalized headers
  const normalizedHeaders = headers.map(h => normalizeHeader(h));
  const hasUserId = normalizedHeaders.includes('UserId');
  const hasName = normalizedHeaders.includes('Name');

  if (hasUserId && !hasName) return 'shift_update';
  if (hasUserId && hasName) return 'update';
  return 'create';
}

// Check if a value is effectively null/empty
function isNullish(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const str = String(value).trim().toLowerCase();
  return str === '' || str === 'null' || str === 'none' || str === 'undefined' || str === 'n/a';
}

function formatDate(value: unknown): string {
  if (isNullish(value)) return '';
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
  // Handle yyyy-MM-dd HH:mm:ss format (strip time)
  const dateTimeMatch = str.match(/^(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}/);
  if (dateTimeMatch) return dateTimeMatch[1];
  // Try to parse other date formats
  const date = new Date(str);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }
  return str;
}

function cleanValue(value: unknown): string {
  if (isNullish(value)) return '';
  return String(value).trim();
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

    const rawHeaders = Object.keys(rawData[0]);
    // Build header mapping: raw -> normalized
    const headerMap = new Map<string, string>();
    for (const raw of rawHeaders) {
      const normalized = normalizeHeader(raw);
      headerMap.set(raw, normalized);
    }

    const normalizedHeaders = rawHeaders
      .map(h => headerMap.get(h) || h)
      .filter(h => CREATE_HEADERS.includes(h) || h === 'UserId');

    const operation = detectOperation(sheetName, rawHeaders);

    // Clean and format rows with normalized headers
    const rows = rawData.map(row => {
      const cleaned: Record<string, unknown> = {};
      for (const [rawKey, value] of Object.entries(row)) {
        const key = headerMap.get(rawKey) || rawKey;

        // Skip unknown/empty column names
        if (!key || key === 'None' || key === 'undefined') continue;

        if (key === 'JoinDate' || key === 'TerminationDate') {
          cleaned[key] = formatDate(value);
        } else if (key === 'UserFeatureIds') {
          const str = cleanValue(value);
          cleaned[key] = str ? str.split(',').map(s => s.trim()).filter(Boolean) : [];
        } else {
          cleaned[key] = cleanValue(value);
        }
      }
      return cleaned;
    });

    results.push({ operation, rows, headers: normalizedHeaders, sheetName });
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
