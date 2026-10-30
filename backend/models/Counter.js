/**
 * Counter: a named sequence that only goes up, e.g. "employeeCode". `seq` is the last number
 * issued. Numbers are taken with one atomic $inc (services/companySettings.js), so concurrent
 * imports never share a number, and a number is never reused, even if what took it is deleted.
 */

import mongoose from 'mongoose';

export const COUNTER_NAMES = Object.freeze({ EMPLOYEE_CODE: 'employeeCode' });

const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, enum: Object.values(COUNTER_NAMES) },
    seq: { type: Number, required: true, min: 0 },
  },
  { versionKey: false },
);

export default mongoose.model('Counter', counterSchema);
