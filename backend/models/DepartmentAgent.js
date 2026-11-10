/**
 * DepartmentAgent: a department's AI agent and the knowledge base behind it. One per department,
 * created the first time someone allowed to manage it opens it (services/knowledge/agentService.js).
 *
 *   departmentId   the department it serves (1:1, never changes)
 *   name           shown to people; defaults to "<department name> Department Agent"
 *   managedBy      the Team Lead responsible for it (an active account). With the department head,
 *                  this person manages the documents and settings; only an admin or the head may
 *                  change who it is
 *   systemPrompt   the department's instructions for the agent, written by its lead. Untrusted
 *                  input: the agent keeps its own rules above it
 *   status         ACTIVE, or PAUSED: a paused agent takes no new documents and answers no questions
 *   audience       who may ask it (AGENT_AUDIENCES): FOLLOW_DEPARTMENT (the default) uses the
 *                  department's shared-service switch; COMPANY or DEPARTMENT overrides it
 *
 * Every change is versioned (optimisticConcurrency), so two leads editing at once cannot overwrite
 * each other.
 */

import mongoose from 'mongoose';
import { AGENT_AUDIENCES, KNOWLEDGE_BASE_SETTINGS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

export const AGENT_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
});

const departmentAgentSchema = new mongoose.Schema(
  {
    departmentId: { type: ObjectId, ref: 'Department', required: true, immutable: true },
    name: {
      type: String,
      required: [true, 'Agent name is required'],
      trim: true,
      minlength: 1,
      maxlength: [
        KNOWLEDGE_BASE_SETTINGS.AGENT_NAME_MAX_LENGTH,
        `Agent name must be at most ${KNOWLEDGE_BASE_SETTINGS.AGENT_NAME_MAX_LENGTH} characters`,
      ],
    },
    managedBy: { type: ObjectId, ref: 'User', default: null },
    systemPrompt: {
      type: String,
      trim: true,
      default: '',
      maxlength: [
        KNOWLEDGE_BASE_SETTINGS.SYSTEM_PROMPT_MAX_LENGTH,
        `Instructions must be at most ${KNOWLEDGE_BASE_SETTINGS.SYSTEM_PROMPT_MAX_LENGTH} characters`,
      ],
    },
    status: {
      type: String,
      enum: Object.values(AGENT_STATUSES),
      default: AGENT_STATUSES.ACTIVE,
      required: true,
    },
    audience: {
      type: String,
      enum: Object.values(AGENT_AUDIENCES),
      default: AGENT_AUDIENCES.FOLLOW_DEPARTMENT,
      required: true,
    },
    createdByUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    updatedByUserId: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

departmentAgentSchema.index({ departmentId: 1 }, { unique: true });
// "Which knowledge bases do I manage?"
departmentAgentSchema.index({ managedBy: 1 });

export default mongoose.model('DepartmentAgent', departmentAgentSchema);
