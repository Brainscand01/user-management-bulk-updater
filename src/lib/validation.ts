export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// 24-char hex MongoDB ObjectId pattern
const OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i;

function isValidObjectId(value: string): boolean {
  return OBJECT_ID_REGEX.test(value);
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return !isNaN(date.getTime());
}

// RSA ID Luhn check
function isValidRSAId(idNumber: string): boolean {
  if (!/^\d{13}$/.test(idNumber)) return false;

  // Check DOB portion is a valid date
  const yy = idNumber.substring(0, 2);
  const mm = idNumber.substring(2, 4);
  const dd = idNumber.substring(4, 6);
  const month = parseInt(mm);
  const day = parseInt(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  // Luhn algorithm
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let digit = parseInt(idNumber[i]);
    if (i % 2 !== 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function required(value: unknown, field: string): ValidationError | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { field, message: `${field} is required` };
  }
  return null;
}

function objectId(value: string, field: string): ValidationError | null {
  if (value && !isValidObjectId(value)) {
    return { field, message: `${field} must be a valid 24-character ID` };
  }
  return null;
}

export function validateCreateUser(row: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  // Mandatory fields
  const mandatoryStrings = [
    'Name', 'Surname', 'IdNumber', 'AD', 'ContactNumber',
    'EmployeeCode', 'JobTitle'
  ];
  for (const field of mandatoryStrings) {
    const err = required(row[field], field);
    if (err) errors.push(err);
  }

  // Mandatory ObjectId fields
  const mandatoryIds = [
    'RoleId', 'ManagerUserId', 'RegionId', 'CampaignId',
    'UserStatusId', 'UserTypeId'
  ];
  for (const field of mandatoryIds) {
    const err = required(row[field], field);
    if (err) {
      errors.push(err);
    } else {
      const idErr = objectId(String(row[field]), field);
      if (idErr) errors.push(idErr);
    }
  }

  // JoinDate
  const joinErr = required(row['JoinDate'], 'JoinDate');
  if (joinErr) {
    errors.push(joinErr);
  } else if (!isValidDate(String(row['JoinDate']))) {
    errors.push({ field: 'JoinDate', message: 'JoinDate must be yyyy-MM-dd format' });
  }

  // IdType
  const idTypeErr = required(row['IdType'], 'IdType');
  if (idTypeErr) {
    errors.push(idTypeErr);
  } else {
    const idType = String(row['IdType']).trim();
    if (idType !== 'RSA ID' && idType !== 'Passport') {
      errors.push({ field: 'IdType', message: 'IdType must be "RSA ID" or "Passport"' });
    }
  }

  // IdNumber validation based on IdType
  const idNumber = String(row['IdNumber'] || '').trim();
  const idType = String(row['IdType'] || '').trim();
  if (idNumber && idType === 'RSA ID') {
    if (!isValidRSAId(idNumber)) {
      errors.push({ field: 'IdNumber', message: 'Invalid RSA ID number (must be 13 digits with valid checksum)' });
    }
  }

  // AD must be valid email
  const ad = String(row['AD'] || '').trim();
  if (ad && !isValidEmail(ad)) {
    errors.push({ field: 'AD', message: 'AD must be a valid email address' });
  }

  // Optional field validations
  const termDate = String(row['TerminationDate'] || '').trim();
  if (termDate) {
    if (!isValidDate(termDate)) {
      errors.push({ field: 'TerminationDate', message: 'TerminationDate must be yyyy-MM-dd format' });
    } else if (row['JoinDate'] && isValidDate(String(row['JoinDate']))) {
      if (new Date(termDate) <= new Date(String(row['JoinDate']))) {
        errors.push({ field: 'TerminationDate', message: 'TerminationDate must be after JoinDate' });
      }
    }
  }

  const termReasonId = String(row['TerminationReasonId'] || '').trim();
  if (termReasonId) {
    const idErr = objectId(termReasonId, 'TerminationReasonId');
    if (idErr) errors.push(idErr);
  }

  const externalAD = String(row['ExternalAD'] || '').trim();
  if (externalAD && !isValidEmail(externalAD)) {
    errors.push({ field: 'ExternalAD', message: 'ExternalAD must be a valid email address' });
  }

  // AgentShiftTimeId validation (optional on create)
  const shiftId = getNestedValue(row, 'AgentShiftTimeId');
  if (shiftId) {
    const idErr = objectId(String(shiftId), 'AgentShiftTimeId');
    if (idErr) errors.push(idErr);
  }

  return { valid: errors.length === 0, errors };
}

export function validateUpdateUser(row: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  // UserId is mandatory for updates
  const userIdErr = required(row['UserId'], 'UserId');
  if (userIdErr) {
    errors.push(userIdErr);
  } else {
    const idErr = objectId(String(row['UserId']), 'UserId');
    if (idErr) errors.push(idErr);
  }

  // If IdType is provided, IdNumber is mandatory
  const idType = String(row['IdType'] || '').trim();
  if (idType) {
    if (idType !== 'RSA ID' && idType !== 'Passport') {
      errors.push({ field: 'IdType', message: 'IdType must be "RSA ID" or "Passport"' });
    }
    const idNumber = String(row['IdNumber'] || '').trim();
    if (!idNumber) {
      errors.push({ field: 'IdNumber', message: 'IdNumber is required when IdType is provided' });
    } else if (idType === 'RSA ID' && !isValidRSAId(idNumber)) {
      errors.push({ field: 'IdNumber', message: 'Invalid RSA ID number' });
    }
  }

  // Validate ObjectId fields if present
  const idFields = [
    'RoleId', 'ManagerUserId', 'RegionId', 'CampaignId',
    'UserStatusId', 'UserTypeId', 'TerminationReasonId'
  ];
  for (const field of idFields) {
    const val = String(row[field] || '').trim();
    if (val) {
      const idErr = objectId(val, field);
      if (idErr) errors.push(idErr);
    }
  }

  // Validate dates if present
  const joinDate = String(row['JoinDate'] || '').trim();
  if (joinDate && !isValidDate(joinDate)) {
    errors.push({ field: 'JoinDate', message: 'JoinDate must be yyyy-MM-dd format' });
  }

  const termDate = String(row['TerminationDate'] || '').trim();
  if (termDate && !isValidDate(termDate)) {
    errors.push({ field: 'TerminationDate', message: 'TerminationDate must be yyyy-MM-dd format' });
  }

  // Email fields
  const ad = String(row['AD'] || '').trim();
  if (ad && !isValidEmail(ad)) {
    errors.push({ field: 'AD', message: 'AD must be a valid email address' });
  }

  const externalAD = String(row['ExternalAD'] || '').trim();
  if (externalAD && !isValidEmail(externalAD)) {
    errors.push({ field: 'ExternalAD', message: 'ExternalAD must be a valid email address' });
  }

  return { valid: errors.length === 0, errors };
}

export function validateShiftUpdate(row: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  const userIdErr = required(row['UserId'], 'UserId');
  if (userIdErr) {
    errors.push(userIdErr);
  } else {
    const idErr = objectId(String(row['UserId']), 'UserId');
    if (idErr) errors.push(idErr);
  }

  const shiftIdErr = required(row['AgentShiftTimeId'], 'AgentShiftTimeId');
  if (shiftIdErr) {
    errors.push(shiftIdErr);
  } else {
    const idErr = objectId(String(row['AgentShiftTimeId']), 'AgentShiftTimeId');
    if (idErr) errors.push(idErr);
  }

  return { valid: errors.length === 0, errors };
}

// Check for duplicate AD values within a batch
export function checkDuplicateADs(rows: Record<string, unknown>[]): Map<number, string> {
  const seen = new Map<string, number>();
  const duplicates = new Map<number, string>();

  rows.forEach((row, index) => {
    const ad = String(row['AD'] || '').trim().toLowerCase();
    if (ad) {
      if (seen.has(ad)) {
        duplicates.set(index, `Duplicate AD: same as row ${seen.get(ad)! + 1}`);
        // Also mark the first occurrence if not already
        if (!duplicates.has(seen.get(ad)!)) {
          duplicates.set(seen.get(ad)!, `Duplicate AD: same as row ${index + 1}`);
        }
      } else {
        seen.set(ad, index);
      }
    }
  });

  return duplicates;
}

function getNestedValue(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key];
  // Check for nested AgentShiftTime.AgentShiftTimeId
  if (key === 'AgentShiftTimeId' && row['AgentShiftTime']) {
    const shift = row['AgentShiftTime'] as Record<string, unknown>;
    return shift['AgentShiftTimeId'];
  }
  return undefined;
}
