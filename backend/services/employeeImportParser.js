/**
 * Reads an import CSV (a template, or a spreadsheet saved as CSV) into rows, streaming it through
 * csv-parse so a large file is never split into lines by hand. One reader serves every import: the
 * employee import (parseEmployeeCsv, EMPLOYEE_CSV) and the offer import (services/offerImport.js)
 * each pass their columns.
 *
 * Headers are matched loosely: case, spaces and hyphens do not matter ("Personal Email" is
 * personal_email), and a few common names are understood (email, work_email, job_title, doj...).
 * Unknown columns are ignored and reported. A UTF-8 byte order mark (Excel's "CSV UTF-8") is
 * skipped; blank lines are ignored.
 */

import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { EMPLOYEE_IMPORT_MESSAGES } from '../constants/messages.js';
import { EMPLOYEE_IMPORT_LIMITS } from '../constants/validation.js';
import { ServiceError } from './serviceError.js';

/** The template's columns, in its order. Required ones must be present (cells are checked later). */
export const IMPORT_COLUMNS = Object.freeze([
  Object.freeze({ name: 'name', required: true }),
  Object.freeze({ name: 'personal_email', required: true }),
  Object.freeze({ name: 'company_email', required: false }),
  Object.freeze({ name: 'department_code', required: true }),
  Object.freeze({ name: 'department_name', required: false }),
  Object.freeze({ name: 'designation', required: true }),
  Object.freeze({ name: 'role', required: false }),
  Object.freeze({ name: 'manager_email', required: false }),
  Object.freeze({ name: 'date_of_joining', required: true }),
  Object.freeze({ name: 'work_type', required: false }),
  Object.freeze({ name: 'employment_status', required: false }),
  Object.freeze({ name: 'office_code', required: false }),
  Object.freeze({ name: 'job_level', required: false }),
  Object.freeze({ name: 'employment_type', required: false }),
]);

/** Other names spreadsheets use for the employee columns. */
export const EMPLOYEE_COLUMN_ALIASES = Object.freeze({
  full_name: 'name',
  employee_name: 'name',
  email: 'personal_email',
  work_email: 'company_email',
  official_email: 'company_email',
  department: 'department_code',
  title: 'designation',
  job_title: 'designation',
  reporting_manager_email: 'manager_email',
  joining_date: 'date_of_joining',
  doj: 'date_of_joining',
  work_location_type: 'work_type',
  office: 'office_code',
});

/** The employee import's columns and limits. */
export const EMPLOYEE_CSV = Object.freeze({
  columns: IMPORT_COLUMNS,
  aliases: EMPLOYEE_COLUMN_ALIASES,
  maxRows: EMPLOYEE_IMPORT_LIMITS.MAX_ROWS,
});

/** "Personal Email" / "personal-email" / " PERSONAL_EMAIL " -> "personal_email" (then aliases). */
export function normalizeColumnName(header, aliases = EMPLOYEE_COLUMN_ALIASES) {
  const normalized = String(header)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return aliases[normalized] ?? normalized;
}

const fileError = (code, message = EMPLOYEE_IMPORT_MESSAGES[code]) =>
  new ServiceError(HTTP_STATUS.BAD_REQUEST, code, message);

/**
 * @param {Buffer} fileBuffer
 * @param {{ columns: { name: string, required: boolean }[], aliases: Record<string, string>, maxRows: number }} spec
 * @returns {Promise<{ rows: { rowNumber: number, values: Record<string, string> }[], ignoredColumns: string[] }>}
 *   rowNumber is the line in the file (the header is line 1).
 * @throws {ServiceError} 400 FILE_NOT_CSV, FILE_EMPTY, TOO_MANY_ROWS or COLUMNS_MISSING
 */
export async function parseImportCsv(fileBuffer, { columns: specColumns, aliases, maxRows }) {
  const knownColumns = new Set(specColumns.map((column) => column.name));
  // A spreadsheet's binary format (xlsx, xls) has NUL bytes; text never does.
  if (fileBuffer.includes(0)) throw fileError('FILE_NOT_CSV');

  let columns = null;
  const parser = Readable.from([fileBuffer]).pipe(
    parse({
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      info: true,
      columns: (headers) => {
        columns = headers.map((header) => normalizeColumnName(header, aliases));
        return columns;
      },
    }),
  );

  const rows = [];
  try {
    for await (const { record, info } of parser) {
      if (rows.length === maxRows) {
        throw fileError('TOO_MANY_ROWS', `${EMPLOYEE_IMPORT_MESSAGES.TOO_MANY_ROWS} (at most ${maxRows} rows)`);
      }
      const values = Object.fromEntries(
        Object.entries(record)
          .filter(([column]) => knownColumns.has(column))
          .map(([column, value]) => [column, value ?? '']),
      );
      rows.push({ rowNumber: info.lines, values });
    }
  } catch (parseError) {
    parser.destroy();
    if (parseError instanceof ServiceError) throw parseError;
    throw fileError('FILE_NOT_CSV');
  }

  if (!columns) throw fileError('FILE_EMPTY');
  const missingColumns = specColumns.filter((column) => column.required && !columns.includes(column.name));
  if (missingColumns.length > 0) {
    throw fileError(
      'COLUMNS_MISSING',
      `${EMPLOYEE_IMPORT_MESSAGES.COLUMNS_MISSING}: ${missingColumns.map((column) => column.name).join(', ')}`,
    );
  }
  if (rows.length === 0) throw fileError('FILE_EMPTY');
  return { rows, ignoredColumns: [...new Set(columns.filter((column) => !knownColumns.has(column)))] };
}

/** An employee CSV (IMPORT_COLUMNS), as parseImportCsv reads it. */
export const parseEmployeeCsv = (fileBuffer) => parseImportCsv(fileBuffer, EMPLOYEE_CSV);
