/**
 * Attendance rules (services/attendancePolicy.js): who may choose which work mode, the punch-in
 * radius that applies, and when a forgotten punch-out is closed automatically.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ATTENDANCE_DEFAULTS } from '../../constants/validation.js';
import {
  allowedWorkModes,
  automaticPunchOut,
  effectiveGeofenceRadiusMeters,
  workedMinutesBetween,
} from '../../services/attendancePolicy.js';

const BENGALURU = Object.freeze({
  timeZone: 'Asia/Kolkata',
  workday: { shiftEndLocalTime: '18:30', autoPunchOutAfterMinutes: 120 },
});

describe('allowedWorkModes', () => {
  it('gives each work type its modes, the usual one first', () => {
    assert.deepEqual(allowedWorkModes('Onsite'), ['office', 'on_duty']);
    assert.deepEqual(allowedWorkModes('Hybrid'), ['office', 'home', 'on_duty']);
    assert.deepEqual(allowedWorkModes('Remote'), ['home', 'office', 'on_duty']);
  });
});

describe('effectiveGeofenceRadiusMeters', () => {
  it('prefers the employee’s own radius, then the office’s, then the default', () => {
    assert.equal(effectiveGeofenceRadiusMeters({ geofenceRadiusMeters: 300 }, 900), 900);
    assert.equal(effectiveGeofenceRadiusMeters({ geofenceRadiusMeters: 300 }, null), 300);
    assert.equal(effectiveGeofenceRadiusMeters({}, undefined), ATTENDANCE_DEFAULTS.OFFICE_GEOFENCE_RADIUS_METRES);
  });
});

describe('automaticPunchOut', () => {
  it('closes a day punch at the shift end, once the delay after it has passed', () => {
    const { closeAt, deadline } = automaticPunchOut(
      { date: '2026-01-05', checkInTime: new Date('2026-01-05T04:10:00Z') },
      BENGALURU,
    );
    assert.equal(closeAt.toISOString(), '2026-01-05T13:00:00.000Z');
    assert.equal(deadline.toISOString(), '2026-01-05T15:00:00.000Z');
  });

  it('closes a punch made after the shift ended once the delay has passed, at that moment', () => {
    const { closeAt, deadline } = automaticPunchOut(
      { date: '2026-01-05', checkInTime: new Date('2026-01-05T14:00:00Z') },
      BENGALURU,
    );
    assert.equal(closeAt.toISOString(), '2026-01-05T16:00:00.000Z');
    assert.equal(deadline.toISOString(), closeAt.toISOString());
  });

  it('closes right at the shift end with no delay, and keeps a late punch at least a minute long', () => {
    const noDelay = { ...BENGALURU, workday: { ...BENGALURU.workday, autoPunchOutAfterMinutes: 0 } };
    const dayPunch = automaticPunchOut({ date: '2026-01-05', checkInTime: new Date('2026-01-05T04:10:00Z') }, noDelay);
    assert.equal(dayPunch.deadline.toISOString(), '2026-01-05T13:00:00.000Z');
    const latePunch = automaticPunchOut({ date: '2026-01-05', checkInTime: new Date('2026-01-05T14:00:00Z') }, noDelay);
    assert.equal(latePunch.closeAt.toISOString(), '2026-01-05T14:01:00.000Z');
  });

  it('uses the default delay for offices saved before it existed', () => {
    const legacyOffice = { timeZone: 'Asia/Kolkata', workday: { shiftEndLocalTime: '18:30' } };
    const { deadline } = automaticPunchOut(
      { date: '2026-01-05', checkInTime: new Date('2026-01-05T04:10:00Z') },
      legacyOffice,
    );
    const expected =
      new Date('2026-01-05T13:00:00Z').getTime() + ATTENDANCE_DEFAULTS.AUTO_PUNCH_OUT_AFTER_MINUTES * 60_000;
    assert.equal(deadline.getTime(), expected);
  });
});

describe('workedMinutesBetween', () => {
  it('counts whole minutes', () => {
    assert.equal(workedMinutesBetween(new Date('2026-01-05T04:10:00Z'), new Date('2026-01-05T13:00:59Z')), 530);
    assert.equal(workedMinutesBetween(new Date('2026-01-05T04:10:00Z'), new Date('2026-01-05T04:10:30Z')), 0);
  });
});
