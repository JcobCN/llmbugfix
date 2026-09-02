import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const bugKey = (sequence: number): string => {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError('Bug sequence must be a positive safe integer');
  return `BUG-${String(sequence).padStart(6, '0')}`;
};
export const isBugKey = (value: string): boolean => /^BUG-[0-9]{6,}$/.test(value);
