/**
 * Today's calendar date (YYYY-MM-DD) in the company's time zone (CompanySettings.timeZone): what due
 * dates, notice periods and "overdue" are measured against, whatever the server's own clock zone.
 */

import { readOfficeLocalClock } from './attendancePolicy.js';
import { getCompanySettings } from './companySettings.js';

export async function companyToday(now = new Date()) {
  const { timeZone } = await getCompanySettings();
  return readOfficeLocalClock(now, timeZone).calendarDate;
}
