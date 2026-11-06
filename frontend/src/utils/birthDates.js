/**
 * Dates of birth on the sign-up screen: shown and typed as mm/dd/yyyy (the design), sent to the
 * server as YYYY-MM-DD. The server checks the date itself and says what is wrong with it.
 */

/** "mm/dd/yyyy" as typed (digits only, slashes added), at most 8 digits. */
export function maskBirthDate(typed) {
  const digits = typed.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
}

/**
 * What the server reads (YYYY-MM-DD) from the typed "mm/dd/yyyy". Anything else is sent as typed,
 * so the server's own message says what is wrong with it.
 */
export function toIsoBirthDate(displayed) {
  const match = displayed.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : displayed.trim();
}

/** "YYYY-MM-DD" (the calendar's value) as "mm/dd/yyyy". */
export const fromIsoDate = (isoDate) => {
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
};

/** The latest date of birth the calendar offers: `years` years before today. */
export const latestBirthDate = (years) => {
  const today = new Date();
  const latest = new Date(today.getFullYear() - years, today.getMonth(), today.getDate());
  const pad = (number) => String(number).padStart(2, '0');
  return `${latest.getFullYear()}-${pad(latest.getMonth() + 1)}-${pad(latest.getDate())}`;
};
