/**
 * Live password-strength checklist. Pass the output of evaluatePasswordRules(); each rule is
 * shown as met or not met. The `listId` lets the password input reference the list via
 * aria-describedby, and screen readers hear the "(met)/(not met)" state for every rule.
 */

export default function PasswordChecklist({ listId, ruleResults }) {
  return (
    <ul id={listId} className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
      {ruleResults.map((ruleResult) => (
        <li
          key={ruleResult.ruleId}
          className={`flex items-center gap-2 transition-colors ${ruleResult.isSatisfied ? 'text-emerald-700' : 'text-slate-500'}`}
        >
          <svg
            className={`h-4 w-4 shrink-0 ${ruleResult.isSatisfied ? 'text-emerald-500' : 'text-slate-300'}`}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
              clipRule="evenodd"
            />
          </svg>
          <span>
            {ruleResult.description}
            <span className="sr-only">{ruleResult.isSatisfied ? ' (met)' : ' (not met)'}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
