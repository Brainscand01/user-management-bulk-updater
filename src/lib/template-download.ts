import * as XLSX from 'xlsx';

const CREATE_HEADERS = [
  'Name', 'Surname', 'IdNumber', 'AD', 'RoleId', 'ManagerUserId',
  'RegionId', 'CampaignId', 'JoinDate', 'IdType', 'ContactNumber',
  'EmployeeCode', 'JobTitle', 'UserStatusId', 'UserTypeId',
  'TerminationDate', 'TerminationReasonId', 'TerminationNotes',
  'Wave', 'Client', 'ExternalAD', 'UserFeatureIds', 'AgentShiftTimeId'
];

const UPDATE_HEADERS = ['UserId', ...CREATE_HEADERS];

const SHIFT_HEADERS = ['UserId', 'AgentShiftTimeId'];

type TemplateType = 'create' | 'update' | 'shift_update';

const SHEET_NAMES: Record<TemplateType, string> = {
  create: 'BulkCreateUsers',
  update: 'BulkUpdateUsers',
  shift_update: 'ShiftUpdate',
};

const FILE_NAMES: Record<TemplateType, string> = {
  create: 'BulkCreateUsers_Template.xlsx',
  update: 'BulkUpdateUsers_Template.xlsx',
  shift_update: 'ShiftUpdate_Template.xlsx',
};

const HEADERS: Record<TemplateType, string[]> = {
  create: CREATE_HEADERS,
  update: UPDATE_HEADERS,
  shift_update: SHIFT_HEADERS,
};

export function downloadTemplate(type: TemplateType) {
  const headers = HEADERS[type];
  const ws = XLSX.utils.aoa_to_sheet([headers]);

  // Set column widths
  ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 14) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAMES[type]);

  // Add a FieldReference sheet with guidance
  const refData = headers.map(h => {
    const info = FIELD_INFO[h];
    return [h, info?.required ?? '', info?.format ?? '', info?.description ?? ''];
  });
  const refWs = XLSX.utils.aoa_to_sheet([
    ['Field', 'Required', 'Format', 'Description'],
    ...refData,
  ]);
  refWs['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 30 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, refWs, 'FieldReference');

  XLSX.writeFile(wb, FILE_NAMES[type]);
}

const FIELD_INFO: Record<string, { required: string; format: string; description: string }> = {
  UserId: { required: 'Yes', format: '24-char hex ObjectId', description: 'Existing user ID from the system' },
  Name: { required: 'Yes', format: 'Text', description: 'First name of the user' },
  Surname: { required: 'Yes', format: 'Text', description: 'Surname / last name' },
  IdNumber: { required: 'Yes', format: '13 digits (RSA ID) or text (Passport)', description: 'Identity number — Luhn-validated for RSA IDs' },
  AD: { required: 'Yes', format: 'email@domain.com', description: 'Active Directory email — must be unique' },
  RoleId: { required: 'Yes', format: '24-char hex ObjectId', description: 'Role identifier' },
  ManagerUserId: { required: 'Yes', format: '24-char hex ObjectId', description: 'Manager user identifier' },
  RegionId: { required: 'Yes', format: '24-char hex ObjectId', description: 'Region identifier' },
  CampaignId: { required: 'Yes', format: '24-char hex ObjectId', description: 'Campaign identifier' },
  JoinDate: { required: 'Yes', format: 'yyyy-MM-dd', description: 'Date the user joined' },
  IdType: { required: 'Yes', format: '"RSA ID" or "Passport"', description: 'Type of identity document' },
  ContactNumber: { required: 'Yes', format: 'Digits only', description: 'Phone number' },
  EmployeeCode: { required: 'Yes', format: 'Text', description: 'Employee code / staff number' },
  JobTitle: { required: 'Yes', format: 'Text', description: 'Job title' },
  UserStatusId: { required: 'Yes', format: '24-char hex ObjectId', description: 'User status identifier' },
  UserTypeId: { required: 'Yes', format: '24-char hex ObjectId', description: 'User type identifier' },
  TerminationDate: { required: 'No', format: 'yyyy-MM-dd', description: 'Termination date (must be after JoinDate)' },
  TerminationReasonId: { required: 'No', format: '24-char hex ObjectId', description: 'Termination reason identifier' },
  TerminationNotes: { required: 'No', format: 'Text', description: 'Notes about termination' },
  Wave: { required: 'No', format: 'Text', description: 'Wave / intake group' },
  Client: { required: 'No', format: 'Text', description: 'Client name' },
  ExternalAD: { required: 'No', format: 'email@domain.com', description: 'External AD email address' },
  UserFeatureIds: { required: 'No', format: 'Comma-separated 24-char hex ObjectIds', description: 'Feature IDs to assign' },
  AgentShiftTimeId: { required: 'No*', format: '24-char hex ObjectId', description: 'Agent shift time identifier (*required for Shift Update)' },
};
