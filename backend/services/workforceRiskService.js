/**
 * Workforce risk analytics: attrition and burnout scores for current employees, classified into
 * bands, with summary metrics for managers.
 *
 * Data: EmployeeProfile.advancedMetrics (attritionRiskIndex, currentBurnoutScore, 0-100, written by
 * the analytics job through POST /api/internal/analytics/employee-scores). These are inferred,
 * sensitive personal data: the fields are select:false on the model, only this service reads them,
 * and the controller restricts access to HR and admins and audits every read.
 *
 * Classification (constants/validation.js WORKFORCE_RISK_BANDS)
 *   unscored   advancedMetrics.computedAt is null (never scored): the stored 0s mean "unknown",
 *              never "safe", so unscored employees are counted separately
 *   safe       < 40      elevated   40-69      critical   ≥ 70
 *   overall band = the worse of the two metric bands
 *
 * Query: one aggregation over current employees (Probation, Active, Notice) joining the account
 * name and department name, filtered and sorted in MongoDB; summary counts are computed in the same
 * pipeline with $facet, so the totals always describe the same filtered population as the rows.
 */

import mongoose from 'mongoose';
import { WORKFORCE_RISK_BANDS } from '../constants/validation.js';
import Department from '../models/Department.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import User from '../models/User.js';

export const RISK_BANDS = Object.freeze({ UNSCORED: 'unscored', SAFE: 'safe', ELEVATED: 'elevated', CRITICAL: 'critical' });
const BAND_SEVERITY = Object.freeze({ [RISK_BANDS.UNSCORED]: -1, [RISK_BANDS.SAFE]: 0, [RISK_BANDS.ELEVATED]: 1, [RISK_BANDS.CRITICAL]: 2 });

export const RISK_SORT_FIELDS = Object.freeze({ ATTRITION: 'attrition', BURNOUT: 'burnout' });
export const RISK_LIST_LIMITS = Object.freeze({ DEFAULT: 100, MAX: 500, TOP_CRITICAL: 5 });

const CURRENT_EMPLOYMENT_STATUSES = Object.freeze([EMPLOYMENT_STATUSES.PROBATION, EMPLOYMENT_STATUSES.ACTIVE, EMPLOYMENT_STATUSES.NOTICE]);

/** The band of one 0-100 score. */
export function classifyRiskScore(score, isScored) {
  if (!isScored) return RISK_BANDS.UNSCORED;
  if (score >= WORKFORCE_RISK_BANDS.CRITICAL_FROM) return RISK_BANDS.CRITICAL;
  if (score >= WORKFORCE_RISK_BANDS.ELEVATED_FROM) return RISK_BANDS.ELEVATED;
  return RISK_BANDS.SAFE;
}

function worseBand(firstBand, secondBand) {
  return BAND_SEVERITY[firstBand] >= BAND_SEVERITY[secondBand] ? firstBand : secondBand;
}

/** MongoDB expression for a band, mirroring classifyRiskScore. */
function bandExpression(scorePath) {
  return {
    $switch: {
      branches: [
        { case: { $eq: ['$advancedMetrics.computedAt', null] }, then: RISK_BANDS.UNSCORED },
        { case: { $gte: [scorePath, WORKFORCE_RISK_BANDS.CRITICAL_FROM] }, then: RISK_BANDS.CRITICAL },
        { case: { $gte: [scorePath, WORKFORCE_RISK_BANDS.ELEVATED_FROM] }, then: RISK_BANDS.ELEVATED },
      ],
      default: RISK_BANDS.SAFE,
    },
  };
}

function bandCounts(bandField) {
  return [{ $group: { _id: `$${bandField}`, count: { $sum: 1 } } }];
}

function toCountMap(groupedCounts) {
  const countMap = { unscored: 0, safe: 0, elevated: 0, critical: 0 };
  for (const groupedCount of groupedCounts) countMap[groupedCount._id] = groupedCount.count;
  return countMap;
}

/**
 * @param {{ departmentId?: string, band?: string, sortBy?: string, limit?: number }} filters
 *   band filters on the overall band
 * @returns {Promise<{ employees: object[], summary: object, thresholds: object }>}
 */
export async function getWorkforceRisk({ departmentId = null, band = null, sortBy = RISK_SORT_FIELDS.ATTRITION, limit = RISK_LIST_LIMITS.DEFAULT }) {
  const matchStage = { 'organizationData.employmentStatus': { $in: CURRENT_EMPLOYMENT_STATUSES } };
  if (departmentId) matchStage['organizationData.departmentId'] = new mongoose.Types.ObjectId(departmentId);
  const primarySortField = sortBy === RISK_SORT_FIELDS.BURNOUT ? 'advancedMetrics.currentBurnoutScore' : 'advancedMetrics.attritionRiskIndex';
  const secondarySortField = sortBy === RISK_SORT_FIELDS.BURNOUT ? 'advancedMetrics.attritionRiskIndex' : 'advancedMetrics.currentBurnoutScore';

  const [result] = await EmployeeProfile.aggregate([
    { $match: matchStage },
    {
      $addFields: {
        'advancedMetrics.computedAt': { $ifNull: ['$advancedMetrics.computedAt', null] },
        attritionBand: bandExpression('$advancedMetrics.attritionRiskIndex'),
        burnoutBand: bandExpression('$advancedMetrics.currentBurnoutScore'),
      },
    },
    {
      $addFields: {
        overallBand: {
          $switch: {
            branches: [
              { case: { $eq: ['$attritionBand', RISK_BANDS.UNSCORED] }, then: RISK_BANDS.UNSCORED },
              { case: { $or: [{ $eq: ['$attritionBand', RISK_BANDS.CRITICAL] }, { $eq: ['$burnoutBand', RISK_BANDS.CRITICAL] }] }, then: RISK_BANDS.CRITICAL },
              { case: { $or: [{ $eq: ['$attritionBand', RISK_BANDS.ELEVATED] }, { $eq: ['$burnoutBand', RISK_BANDS.ELEVATED] }] }, then: RISK_BANDS.ELEVATED },
            ],
            default: RISK_BANDS.SAFE,
          },
        },
        // Unscored employees sort after every scored one.
        isScored: { $cond: [{ $eq: ['$advancedMetrics.computedAt', null] }, 0, 1] },
      },
    },
    {
      $facet: {
        rows: [
          ...(band ? [{ $match: { overallBand: band } }] : []),
          { $sort: { isScored: -1, [primarySortField]: -1, [secondarySortField]: -1, _id: 1 } },
          { $limit: limit },
          { $lookup: { from: User.collection.collectionName, localField: 'userId', foreignField: '_id', pipeline: [{ $project: { _id: 0, name: 1 } }], as: 'account' } },
          { $lookup: { from: Department.collection.collectionName, localField: 'organizationData.departmentId', foreignField: '_id', pipeline: [{ $project: { _id: 0, name: 1 } }], as: 'department' } },
          {
            $project: {
              _id: 0,
              employeeId: { $toString: '$_id' },
              name: { $ifNull: [{ $first: '$account.name' }, null] },
              designation: '$organizationData.designation',
              departmentId: { $toString: '$organizationData.departmentId' },
              departmentName: { $ifNull: [{ $first: '$department.name' }, null] },
              employmentStatus: '$organizationData.employmentStatus',
              attritionRiskIndex: '$advancedMetrics.attritionRiskIndex',
              currentBurnoutScore: '$advancedMetrics.currentBurnoutScore',
              attritionBand: 1,
              burnoutBand: 1,
              overallBand: 1,
              scoredAt: '$advancedMetrics.computedAt',
              modelVersion: { $ifNull: ['$advancedMetrics.modelVersion', null] },
            },
          },
        ],
        attritionCounts: bandCounts('attritionBand'),
        burnoutCounts: bandCounts('burnoutBand'),
        overallCounts: bandCounts('overallBand'),
        averages: [
          { $match: { isScored: 1 } },
          { $group: { _id: null, attrition: { $avg: '$advancedMetrics.attritionRiskIndex' }, burnout: { $avg: '$advancedMetrics.currentBurnoutScore' }, lastScoredAt: { $max: '$advancedMetrics.computedAt' } } },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const averages = result.averages[0] ?? null;
  const employees = result.rows.map((row) => ({
    ...row,
    // Unscored rows show null scores, not the meaningless stored zeros.
    attritionRiskIndex: row.attritionBand === RISK_BANDS.UNSCORED ? null : row.attritionRiskIndex,
    currentBurnoutScore: row.burnoutBand === RISK_BANDS.UNSCORED ? null : row.currentBurnoutScore,
    overallBand: worseBand(row.attritionBand, row.burnoutBand) === RISK_BANDS.UNSCORED ? RISK_BANDS.UNSCORED : row.overallBand,
    scoredAt: row.scoredAt ? new Date(row.scoredAt).toISOString() : null,
  }));
  return {
    employees,
    summary: {
      currentEmployees: result.total[0]?.count ?? 0,
      attrition: toCountMap(result.attritionCounts),
      burnout: toCountMap(result.burnoutCounts),
      overall: toCountMap(result.overallCounts),
      averageAttritionRiskIndex: averages ? Math.round(averages.attrition * 10) / 10 : null,
      averageBurnoutScore: averages ? Math.round(averages.burnout * 10) / 10 : null,
      lastScoredAt: averages?.lastScoredAt ? new Date(averages.lastScoredAt).toISOString() : null,
      criticalCount: toCountMap(result.overallCounts).critical,
    },
    thresholds: { elevatedFrom: WORKFORCE_RISK_BANDS.ELEVATED_FROM, criticalFrom: WORKFORCE_RISK_BANDS.CRITICAL_FROM, scale: '0-100' },
  };
}

/**
 * Writes model scores in bulk (the analytics job). One bulkWrite: per employee, sets both scores,
 * the computation time and the model version. bulkWrite deliberately bypasses query middleware, so
 * score updates do not invalidate the org-chart cache (scores are not part of the chart).
 * @param {{ modelVersion: string, computedAt: Date, scores: Array<{ employeeId: string, attritionRiskIndex: number, currentBurnoutScore: number }> }} scoreBatch
 * @returns {Promise<{ updated: number, unknownEmployeeIds: string[] }>}
 */
export async function recordEmployeeScores({ modelVersion, computedAt, scores }) {
  const scoredEmployeeIds = scores.map((score) => new mongoose.Types.ObjectId(score.employeeId));
  const existingProfiles = await EmployeeProfile.find({ _id: { $in: scoredEmployeeIds } }).select('_id').lean();
  const existingIds = new Set(existingProfiles.map((profile) => profile._id.toString()));
  const knownScores = scores.filter((score) => existingIds.has(score.employeeId));
  if (knownScores.length > 0) {
    await EmployeeProfile.bulkWrite(
      knownScores.map((score) => ({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(score.employeeId) },
          update: {
            $set: {
              'advancedMetrics.attritionRiskIndex': score.attritionRiskIndex,
              'advancedMetrics.currentBurnoutScore': score.currentBurnoutScore,
              'advancedMetrics.computedAt': computedAt,
              'advancedMetrics.modelVersion': modelVersion,
            },
          },
        },
      })),
      { ordered: false },
    );
  }
  return { updated: knownScores.length, unknownEmployeeIds: scores.filter((score) => !existingIds.has(score.employeeId)).map((score) => score.employeeId) };
}
