/** Offer form values as the backend takes them (offers.js). */

import { describe, expect, it } from 'vitest';
import { fieldErrorOf, offerRequestFromForm } from './offers.js';

const FORM = {
  name: ' Asha Rao ',
  email: 'asha@example.com',
  dateOfBirth: '1995-06-15',
  gender: '',
  role: 'employee',
  designation: 'Engineer',
  departmentId: 'd1',
  reportingManagerId: '',
  workLocationType: 'Hybrid',
  dateOfJoining: '2026-12-15',
  employmentStatus: 'Probation',
  annualCtc: '25,00,000',
  taxRegime: 'new',
  workCity: 'Bengaluru',
  professionalTaxState: 'KA',
  variablePayAnnual: '',
  esopUnits: '',
  basicAnnual: '',
  hraAnnual: '',
  specialAllowanceAnnual: '',
  probationMonths: '',
  noticePeriodDays: '',
  offerValidUntil: '',
};

describe('offer requests', () => {
  it('sends amounts as whole numbers and leaves out what was not given', () => {
    const request = offerRequestFromForm(FORM);
    expect(request.name).toBe('Asha Rao');
    expect(request.annualCtc).toBe(25_00_000);
    expect(request.reportingManagerId).toBeNull();
    expect(request.gender).toBeUndefined();
    expect(request.variablePayAnnual).toBeUndefined();
    expect(request).not.toHaveProperty('components');
    expect(request).not.toHaveProperty('terms');
  });

  it('groups a split and terms when any part is given, and keeps unreadable text for the backend to refuse', () => {
    const request = offerRequestFromForm({
      ...FORM,
      basicAnnual: '10,00,000',
      probationMonths: '3',
      annualCtc: 'lots',
    });
    expect(request.components).toEqual({
      basicAnnual: 10_00_000,
      hraAnnual: undefined,
      specialAllowanceAnnual: undefined,
    });
    expect(request.terms).toEqual({ probationMonths: 3, noticePeriodDays: undefined, offerValidUntil: undefined });
    expect(request.annualCtc).toBe('lots');
  });

  it('finds a nested field error by its form field', () => {
    const errors = { 'components.basicAnnual': 'too high', 'terms.probationMonths': 'too long', name: 'needed' };
    expect(fieldErrorOf(errors, 'basicAnnual')).toBe('too high');
    expect(fieldErrorOf(errors, 'probationMonths')).toBe('too long');
    expect(fieldErrorOf(errors, 'name')).toBe('needed');
  });
});
