/**
 * The offer settings form and the backend's settings (utils/offerSettings.js): percentages to basis
 * points, lists one per line, only changed fields of the groups a person may change, with the version.
 */

import { describe, expect, it } from 'vitest';
import { settingsChangeRequest, settingsFormFrom } from './offerSettings.js';

const SETTINGS = Object.freeze({
  version: 3,
  offerTerms: {
    probationMonths: 6,
    noticePeriodDays: 60,
    weeklyWorkingHours: 40,
    offerValidityDays: 7,
    signatoryName: null,
    signatoryTitle: null,
    additionalClauses: [],
    shiftTimings: null,
    confidentialityClause: 'Keep it confidential.',
    ipAssignmentClause: 'Work belongs to the company.',
    nonSolicitationClause: 'Do not poach.',
    nonSolicitationMonths: 12,
    backgroundVerificationClause: 'We may verify.',
    esopNote: 'Vests over four years.',
    joiningChecklist: ['PAN card', 'Photographs'],
  },
  compensation: {
    basicShareBasisPoints: 5000,
    hraFiftyPercentCityBasisPoints: 5000,
    hraOtherCityBasisPoints: 4000,
    pfOnFullBasic: false,
    includeGratuityInCtc: false,
  },
});
const BOTH = { canEditTerms: true, canEditCompensation: true };

describe('offer settings form', () => {
  it('shows rates as percentages, lists one per line and empty texts as blanks', () => {
    const form = settingsFormFrom(SETTINGS);
    expect(form.compensation.basicShareBasisPoints).toBe('50');
    expect(form.compensation.hraOtherCityBasisPoints).toBe('40');
    expect(form.offerTerms.joiningChecklist).toBe('PAN card\nPhotographs');
    expect(form.offerTerms.signatoryName).toBe('');
    expect(form.offerTerms.probationMonths).toBe('6');
  });

  it('sends nothing when nothing changed', () => {
    expect(settingsChangeRequest(settingsFormFrom(SETTINGS), SETTINGS, BOTH)).toBeNull();
  });

  it('sends only the changed fields, converted, with the version loaded', () => {
    const form = settingsFormFrom(SETTINGS);
    form.offerTerms.signatoryName = '  Example Signatory ';
    form.offerTerms.noticePeriodDays = '30';
    form.offerTerms.joiningChecklist = 'PAN card\n\n  Photographs \nAadhaar card';
    form.offerTerms.shiftTimings = '   ';
    form.compensation.basicShareBasisPoints = '45.5';
    form.compensation.includeGratuityInCtc = true;
    expect(settingsChangeRequest(form, SETTINGS, BOTH)).toEqual({
      version: 3,
      offerTerms: {
        signatoryName: 'Example Signatory',
        noticePeriodDays: 30,
        joiningChecklist: ['PAN card', 'Photographs', 'Aadhaar card'],
      },
      compensation: { basicShareBasisPoints: 4550, includeGratuityInCtc: true },
    });
  });

  it('leaves out the groups this person may not change', () => {
    const form = settingsFormFrom(SETTINGS);
    form.offerTerms.signatoryName = 'Example Signatory';
    form.compensation.pfOnFullBasic = true;
    expect(settingsChangeRequest(form, SETTINGS, { canEditTerms: true, canEditCompensation: false })).toEqual({
      version: 3,
      offerTerms: { signatoryName: 'Example Signatory' },
    });
    expect(settingsChangeRequest(form, SETTINGS, { canEditTerms: false, canEditCompensation: true })).toEqual({
      version: 3,
      compensation: { pfOnFullBasic: true },
    });
    expect(settingsChangeRequest(form, SETTINGS, { canEditTerms: false, canEditCompensation: false })).toBeNull();
  });

  it('passes a mistyped number on as typed, for the backend to name the problem', () => {
    const form = settingsFormFrom(SETTINGS);
    form.offerTerms.probationMonths = '6.5';
    form.compensation.hraOtherCityBasisPoints = '';
    expect(settingsChangeRequest(form, SETTINGS, BOTH)).toEqual({
      version: 3,
      offerTerms: { probationMonths: '6.5' },
      compensation: { hraOtherCityBasisPoints: '' },
    });
  });
});
