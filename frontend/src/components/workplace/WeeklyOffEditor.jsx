/**
 * Edits an office's weekly offs (workday.weeklyOffRules): for each weekday, a working day, off
 * every week, or off on some weeks of the month ("2nd and 4th Saturday"). Produces the rules the
 * backend stores: [{ weekday, occurrencesInMonth }], an empty list meaning every week.
 */

import { WEEKDAY_NAMES, WEEKDAY_OCCURRENCES, WEEKDAYS_FROM_MONDAY } from '../../constants/workplace.js';

const DAY_MODES = Object.freeze({ WORKING: 'working', EVERY_WEEK: 'every', SOME_WEEKS: 'some' });

function modeOf(rule) {
  if (!rule) return DAY_MODES.WORKING;
  return rule.occurrencesInMonth.length === 0 ? DAY_MODES.EVERY_WEEK : DAY_MODES.SOME_WEEKS;
}

/**
 * @param {{ rules: { weekday: number, occurrencesInMonth: number[] }[],
 *           onChange: (rules: object[]) => void, error?: string }} props
 */
export default function WeeklyOffEditor({ rules, onChange, error }) {
  const ruleByWeekday = new Map(rules.map((rule) => [rule.weekday, rule]));

  function setRule(weekday, nextRule) {
    const otherRules = rules.filter((rule) => rule.weekday !== weekday);
    onChange(nextRule ? [...otherRules, nextRule].sort((first, second) => first.weekday - second.weekday) : otherRules);
  }

  function changeMode(weekday, mode) {
    if (mode === DAY_MODES.WORKING) setRule(weekday, null);
    else if (mode === DAY_MODES.EVERY_WEEK) setRule(weekday, { weekday, occurrencesInMonth: [] });
    // Starting point for "some weeks": the common 2nd and 4th.
    else setRule(weekday, { weekday, occurrencesInMonth: [2, 4] });
  }

  function toggleOccurrence(weekday, occurrence) {
    const current = ruleByWeekday.get(weekday).occurrencesInMonth;
    const next = current.includes(occurrence)
      ? current.filter((value) => value !== occurrence)
      : [...current, occurrence].sort((first, second) => first - second);
    // Unticking every week means the day is worked.
    setRule(weekday, next.length === 0 ? null : { weekday, occurrencesInMonth: next });
  }

  return (
    <fieldset>
      <legend className="text-sm font-semibold text-slate-900">Weekly offs</legend>
      <p className="mt-0.5 text-xs text-slate-500">
        Days off every week, or on some weeks of the month. Holidays are added separately.
      </p>
      <ul className="mt-3 divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
        {WEEKDAYS_FROM_MONDAY.map((weekday) => {
          const rule = ruleByWeekday.get(weekday);
          const mode = modeOf(rule);
          const dayName = WEEKDAY_NAMES[weekday];
          return (
            <li key={weekday} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="w-28 text-sm font-medium text-slate-800">{dayName}</span>
              <select
                aria-label={`${dayName} schedule`}
                value={mode}
                onChange={(changeEvent) => changeMode(weekday, changeEvent.target.value)}
                className="rounded-lg border-0 py-1.5 pr-8 pl-3 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-500"
              >
                <option value={DAY_MODES.WORKING}>Working day</option>
                <option value={DAY_MODES.EVERY_WEEK}>Off every week</option>
                <option value={DAY_MODES.SOME_WEEKS}>Off on some weeks</option>
              </select>
              {mode === DAY_MODES.SOME_WEEKS && (
                <span className="flex flex-wrap gap-2" role="group" aria-label={`Which ${dayName}s are off`}>
                  {WEEKDAY_OCCURRENCES.map(({ value, label }) => (
                    <label key={value} className="flex items-center gap-1.5 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                        checked={rule.occurrencesInMonth.includes(value)}
                        onChange={() => toggleOccurrence(weekday, value)}
                      />
                      {label}
                    </label>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </fieldset>
  );
}
