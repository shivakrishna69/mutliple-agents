/**
 * The compact strength bar under a new-password field (reset password, invitation), as in the
 * reset design: one segment per strength level, then each rule with a tick once it is met. Built
 * from the server's policy (GET /api/auth/password-policy): its checks, labels and levels. Nothing
 * about the rules is written here, so the screen and the server always agree; the server still
 * checks the password on submit and names any rule it misses.
 */

import { evaluatePasswordChecks } from '../../validation/passwordPolicyChecks.js';

const LEVEL_COLOURS = Object.freeze({
  weak: 'bg-red-500',
  fair: 'bg-amber-500',
  good: 'bg-emerald-400',
  strong: 'bg-emerald-500',
});

function Tick() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

/**
 * @param {{ password: string, passwordPolicy: object|null, listId: string }} props
 *   listId: the rule list's id, for the password input's aria-describedby
 */
export default function PasswordStrength({ password, passwordPolicy, listId }) {
  if (!passwordPolicy) return null;
  const checks = evaluatePasswordChecks(password, passwordPolicy);
  const metCount = checks.filter((check) => check.isMet).length;
  const level = passwordPolicy.strengthLevels.filter((candidate) => metCount >= candidate.minimumChecksMet).at(-1);
  const filledSegments = password ? passwordPolicy.strengthLevels.indexOf(level) + 1 : 0;

  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {passwordPolicy.strengthLevels.map((segmentLevel, index) => (
          <span
            key={segmentLevel.level}
            className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
              index < filledSegments ? LEVEL_COLOURS[level.level] : 'bg-slate-200'
            }`}
          />
        ))}
      </div>
      {password && (
        <p className="sr-only" aria-live="polite">
          Password strength: {level.label}
        </p>
      )}
      <ul id={listId} aria-label="Password requirements" className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
        {checks.map((check) => (
          <li
            key={check.id}
            className={`flex items-center gap-1 transition-colors ${check.isMet ? 'text-emerald-600' : 'text-slate-400'}`}
          >
            {check.isMet ? <Tick /> : <span className="mx-1 h-1 w-1 rounded-full bg-current" aria-hidden="true" />}
            <span>{check.label}</span>
            <span className="sr-only">{check.isMet ? '(met)' : '(not met yet)'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
