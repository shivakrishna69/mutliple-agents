/**
 * Reading employee CSVs (services/employeeImportParser.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMPLOYEE_IMPORT_LIMITS } from '../../constants/validation.js';
import { normalizeColumnName, parseEmployeeCsv } from '../../services/employeeImportParser.js';

const header = 'name,personal_email,department_code,designation,date_of_joining';

async function refusalCode(content) {
  try {
    await parseEmployeeCsv(Buffer.from(content));
  } catch (error) {
    return error.code;
  }
  return null;
}

describe('normalizeColumnName', () => {
  it('ignores case, spaces and hyphens, and understands common names', () => {
    assert.equal(normalizeColumnName(' Personal Email '), 'personal_email');
    assert.equal(normalizeColumnName('Date-Of-Joining'), 'date_of_joining');
    assert.equal(normalizeColumnName('Email'), 'personal_email');
    assert.equal(normalizeColumnName('Work Email'), 'company_email');
    assert.equal(normalizeColumnName('DOJ'), 'date_of_joining');
  });
});

describe('parseEmployeeCsv', () => {
  it("reads Excel's CSV UTF-8 with quoted cells, numbering rows by their line in the file", async () => {
    const byteOrderMark = String.fromCharCode(0xfeff);
    const content = `${byteOrderMark}Full Name,Email,Department,Job Title,DOJ,Notes\n"Rao, Hema",HEMA@example.com,HR,"Lead ""People""",2026-11-02,x\n\nAsha,asha@example.com,ENG,Engineer,2026-11-03,`;
    const { rows, ignoredColumns } = await parseEmployeeCsv(Buffer.from(content));
    assert.deepEqual(ignoredColumns, ['notes']);
    assert.deepEqual(rows, [
      {
        rowNumber: 2,
        values: {
          name: 'Rao, Hema',
          personal_email: 'HEMA@example.com',
          department_code: 'HR',
          designation: 'Lead "People"',
          date_of_joining: '2026-11-02',
        },
      },
      {
        rowNumber: 4,
        values: {
          name: 'Asha',
          personal_email: 'asha@example.com',
          department_code: 'ENG',
          designation: 'Engineer',
          date_of_joining: '2026-11-03',
        },
      },
    ]);
  });

  it('refuses spreadsheets, broken CSV, files without rows or required columns, and too many rows', async () => {
    assert.equal(await refusalCode('PK\u0003\u0004\u0000'), 'FILE_NOT_CSV');
    assert.equal(await refusalCode(`${header}\n"unclosed,x`), 'FILE_NOT_CSV');
    assert.equal(await refusalCode(''), 'FILE_EMPTY');
    assert.equal(await refusalCode(`${header}\n\n`), 'FILE_EMPTY');
    assert.equal(await refusalCode('name,email\nA,a@example.com'), 'COLUMNS_MISSING');
    const tooMany = [header, ...Array(EMPLOYEE_IMPORT_LIMITS.MAX_ROWS + 1).fill('A,a@example.com,ENG,Eng,2026-11-02')];
    assert.equal(await refusalCode(tooMany.join('\n')), 'TOO_MANY_ROWS');
    const justEnough = [header, ...Array(EMPLOYEE_IMPORT_LIMITS.MAX_ROWS).fill('A,a@example.com,ENG,Eng,2026-11-02')];
    assert.equal(
      (await parseEmployeeCsv(Buffer.from(justEnough.join('\n')))).rows.length,
      EMPLOYEE_IMPORT_LIMITS.MAX_ROWS,
    );
  });
});
