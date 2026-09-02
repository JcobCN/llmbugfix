import { describe, expect, it } from 'vitest';
import { assertValidTransition, canTransition } from './state-machine.js';
describe('bug lifecycle', () => { it('accepts normal transitions and rejects skips', () => { expect(canTransition('DRAFT', 'COLLECTING')).toBe(true); expect(canTransition('DRAFT', 'FIXING')).toBe(false); expect(() => assertValidTransition('DRAFT', 'FIXING')).toThrow(); }); });
