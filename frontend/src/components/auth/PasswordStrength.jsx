/**
 * The strength meter and checklist under a new-password field, built from the server's policy
 * (GET /api/auth/password-policy): its checks (minimum length, then a regular expression per rule),
 * their labels, and the meter's levels and labels. Nothing about the rules is written here, so the
 * screen and the server always agree; the server still checks the password on submit.
 */

import { evaluatePasswordChecks } from '../../validation/passwordPolicyChecks.js';

const LEVEL_COLOURS = Object.freeze({
  weak: 'bg-red-500',
  fair: 'bg-amber-500',
  good: 'bg-sky-500',
  strong: 'bg-emerald-500',
});

function CheckMark({ isMet }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={`h-4 w-4 shrink-0 ${isMet ? 'text-emerald-600' : 'text-slate-300'}`}
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * @param {{ password: string, passwordPolicy: object|null, listId: string }} props
 *   listId: the checklist's id, for the password input's aria-describedby
 */
export default function PasswordStrength({ password, passwordPolicy, listId }) {
  if (!passwordPolicy) return null;
  const checks = evaluatePasswordChecks(password, passwordPolicy);
  const metCount = checks.filter((check) => check.isMet).length;
  const level = passwordPolicy.strengthLevels.filter((candidate) => metCount >= candidate.minimumChecksMet).at(-1);
  const segments = passwordPolicy.strengthLevels.length;
  const filledSegments = password ? passwordPolicy.strengthLevels.indexOf(level) + 1 : 0;

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-slate-600">Password strength</span>
        {password && (
          <span className="font-semibold text-slate-800" aria-live="polite">
            {level.label}
          </span>
        )}
      </div>
      <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${segments}, minmax(0, 1fr))` }}>
        {passwordPolicy.strengthLevels.map((segmentLevel, index) => (
          <span
            key={segmentLevel.level}
            className={`h-1.5 rounded-full ${index < filledSegments ? LEVEL_COLOURS[level.level] : 'bg-slate-200'}`}
          />
        ))}
      </div>
      <ul id={listId} className="mt-3 grid gap-1.5 text-xs sm:grid-cols-2" aria-label="Password requirements">
        {checks.map((check) => (
          <li
            key={check.id}
            className={`flex items-center gap-1.5 ${check.isMet ? 'text-emerald-700' : 'text-slate-500'}`}
          >
            <CheckMark isMet={check.isMet} />
            <span>{check.label}</span>
            <span className="sr-only">{check.isMet ? '(met)' : '(not met yet)'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
