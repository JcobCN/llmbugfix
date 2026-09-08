import { ConflictError } from '@llmbugfix/shared';
import { BugStatusSchema, type BugStatus } from './schemas.js';

const transitions: Record<BugStatus, readonly BugStatus[]> = {
  DRAFT: ['COLLECTING'], COLLECTING: ['READY_FOR_CONFIRMATION'], READY_FOR_CONFIRMATION: ['SUBMITTED'], SUBMITTED: ['TRIAGING'],
  TRIAGING: ['QUEUED', 'NEEDS_INFO'], NEEDS_INFO: ['TRIAGING', 'CANCELLED'], QUEUED: ['PREPARING_ENV', 'CANCELLED'],
  PREPARING_ENV: ['FIXING', 'ENVIRONMENT_FAILED', 'FIX_FAILED', 'BLOCKED', 'CANCELLED'], FIXING: ['VALIDATING', 'FIX_CANDIDATE', 'FIX_FAILED', 'BLOCKED', 'CANCELLED'],
  FIX_CANDIDATE: ['VALIDATING', 'FIX_FAILED', 'QUEUED', 'BLOCKED', 'CANCELLED'],
  VALIDATING: ['REVIEWING', 'VALIDATION_FAILED', 'FIX_FAILED', 'BLOCKED'], REVIEWING: ['FIX_READY', 'REVIEW_REJECTED', 'FIX_FAILED', 'BLOCKED'],
  FIX_READY: ['PUSHING', 'CANCELLED'], PUSHING: ['READY_FOR_HUMAN_REVIEW', 'PUSH_FAILED', 'BLOCKED'],
  READY_FOR_HUMAN_REVIEW: ['QUEUED', 'CANCELLED', 'REJECTED'], FIX_FAILED: ['QUEUED', 'CANCELLED', 'BLOCKED'],
  ENVIRONMENT_FAILED: ['QUEUED', 'CANCELLED', 'BLOCKED'], VALIDATION_FAILED: ['FIXING', 'QUEUED', 'CANCELLED'],
  REVIEW_REJECTED: ['FIXING', 'QUEUED', 'CANCELLED'], PUSH_FAILED: ['PUSHING', 'QUEUED', 'CANCELLED'],
  BLOCKED: ['QUEUED', 'CANCELLED'], CANCELLED: [], REJECTED: [],
};

export const canTransition = (from: BugStatus, to: BugStatus): boolean => {
  BugStatusSchema.parse(from); BugStatusSchema.parse(to);
  return transitions[from].includes(to);
};
export const assertValidTransition = (from: BugStatus, to: BugStatus): void => { if (!canTransition(from, to)) throw new ConflictError(`Invalid bug status transition: ${from} -> ${to}`, { from, to }); };
export const transitionBugStatus = (from: BugStatus, to: BugStatus): BugStatus => { assertValidTransition(from, to); return to; };
export const allowedTransitions = (from: BugStatus): readonly BugStatus[] => transitions[from];
