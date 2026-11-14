/**
 * What an NSK people lookup may show about a person: one table, so every tool and every role follow
 * the same rules (PROFILE_FIELD_RULES).
 *
 *   open          shown to everyone who may look the person up: name, employee ID, role, designation,
 *                 department, reporting manager, joining date, employment status, work location
 *                 type, office, shift, today's attendance, leave balances
 *   masked        always masked, for every role: the phone number keeps only its last
 *                 NSK_BOT_SETTINGS.PHONE_VISIBLE_DIGITS digits ("+••••••••••10")
 *   restricted    shown only with the field's capability: salary (latest issued payslip) needs
 *                 MANAGE_COMPENSATION (admin, HR, finance); otherwise the field is replaced by a note
 *                 saying it is not shown to this role
 *
 * Fields that are never read at all: personal email, date of birth, address, bank and identity
 * details, device and location data. revealProfile also reports which fields were shown, for the
 * audit log.
 */

import { CAPABILITIES, hasCapability } from '../../constants/accessRoles.js';
import { NSK_BOT_MESSAGES } from '../../constants/messages.js';
import { NSK_BOT_SETTINGS } from '../../constants/validation.js';

export const FIELD_TREATMENTS = Object.freeze({ OPEN: 'open', MASKED: 'masked', RESTRICTED: 'restricted' });

export const PROFILE_FIELD_RULES = Object.freeze({
  name: { treatment: FIELD_TREATMENTS.OPEN },
  employee_code: { treatment: FIELD_TREATMENTS.OPEN },
  role: { treatment: FIELD_TREATMENTS.OPEN },
  designation: { treatment: FIELD_TREATMENTS.OPEN },
  department: { treatment: FIELD_TREATMENTS.OPEN },
  reporting_manager: { treatment: FIELD_TREATMENTS.OPEN },
  joining_date: { treatment: FIELD_TREATMENTS.OPEN },
  employment_status: { treatment: FIELD_TREATMENTS.OPEN },
  work_location_type: { treatment: FIELD_TREATMENTS.OPEN },
  office: { treatment: FIELD_TREATMENTS.OPEN },
  shift: { treatment: FIELD_TREATMENTS.OPEN },
  attendance_today: { treatment: FIELD_TREATMENTS.OPEN },
  leave_balances: { treatment: FIELD_TREATMENTS.OPEN },
  phone: { treatment: FIELD_TREATMENTS.MASKED },
  salary: {
    treatment: FIELD_TREATMENTS.RESTRICTED,
    capability: CAPABILITIES.MANAGE_COMPENSATION,
    hiddenNote: NSK_BOT_MESSAGES.SALARY_HIDDEN,
  },
});

const MASK_CHARACTER = '•';

/** The phone number with every digit but the last few masked; null stays null. */
export function maskPhone(phoneNumber) {
  if (typeof phoneNumber !== 'string' || phoneNumber.trim() === '') return null;
  const digits = phoneNumber.replace(/\D/g, '');
  const visible = NSK_BOT_SETTINGS.PHONE_VISIBLE_DIGITS;
  const masked = MASK_CHARACTER.repeat(Math.max(digits.length - visible, 0)) + digits.slice(-visible);
  return phoneNumber.trim().startsWith('+') ? `+${masked}` : masked;
}

const MASKERS = Object.freeze({ phone: maskPhone });

/**
 * The profile as `role` may see it, and the names of the fields shown (masked ones included).
 * Fields not in PROFILE_FIELD_RULES are dropped, so a new field is hidden until it is classified.
 * @param {Record<string, unknown>} profile  every field, unmasked
 * @param {string} role
 * @returns {{ profile: Record<string, unknown>, fieldsShown: string[] }}
 */
export function revealProfile(profile, role) {
  const shown = {};
  const fieldsShown = [];
  for (const [field, rule] of Object.entries(PROFILE_FIELD_RULES)) {
    if (!Object.hasOwn(profile, field)) continue;
    if (rule.treatment === FIELD_TREATMENTS.RESTRICTED && !hasCapability(role, rule.capability)) {
      shown[field] = { hidden: true, note: rule.hiddenNote };
      continue;
    }
    shown[field] = rule.treatment === FIELD_TREATMENTS.MASKED ? MASKERS[field](profile[field]) : profile[field];
    fieldsShown.push(field);
  }
  return { profile: shown, fieldsShown };
}
