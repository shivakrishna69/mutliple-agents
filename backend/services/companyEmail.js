/**
 * Company email addresses in the company's mail domain (models/CompanySettings.js emailDomain):
 * "firstname.lastname@domain", or "firstname.lastname2@domain" when that is taken, as most
 * companies do. A company without a mail domain gives no address.
 *
 * The address is reserved on the account (User.companyEmail, unique). Creating the mailbox itself
 * happens at the mail provider; this only decides the address.
 */

import User from '../models/User.js';

/** "Ádupa  Rajeshwari" -> "adupa.rajeshwari"; one word -> that word; nothing usable -> null. */
export function emailLocalPartFromName(name) {
  const words = String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.length === 1 ? words[0] : `${words[0]}.${words[words.length - 1]}`;
}

const isAddressTaken = (address) => User.exists({ $or: [{ companyEmail: address }, { email: address }] }).then(Boolean);

/**
 * The first free address for `name` in `emailDomain`, or null without a domain or a usable name.
 * Free when checked; the unique index on User.companyEmail settles two people taking it at once.
 */
export async function suggestCompanyEmail(name, emailDomain) {
  const localPart = emailLocalPartFromName(name);
  if (!emailDomain || !localPart) return null;
  for (let suffixNumber = 1; ; suffixNumber += 1) {
    const address = `${localPart}${suffixNumber === 1 ? '' : suffixNumber}@${emailDomain}`;
    if (!(await isAddressTaken(address))) return address;
  }
}
