// The logical functions. IF, IFERROR and IFNA answer with the branch they pick, which is evaluated only then; AND
// and OR take every truth value of their arguments, and with nothing to take they are #VALUE!.

import { NA, VALUE } from '../values/errors';
import { isError } from '../values/value';
import { ANY, BOOLEAN, fn, LAZY, optional, rest, TRUTHS } from './registry';

export const LOGICAL = [
    fn('AND', [rest(TRUTHS)], (truths) => (truths.count() === 0 ? VALUE : !truths.holds(0))),
    fn('OR', [rest(TRUTHS)], (truths) => (truths.count() === 0 ? VALUE : truths.min() !== 0 || truths.max() !== 0)),
    fn('NOT', [BOOLEAN], (truth) => !truth),
    fn('IF', [BOOLEAN, LAZY, optional(LAZY, false)], (test, then, otherwise) => (test ? then : otherwise)),
    fn('IFERROR', [ANY, LAZY], (value, fallback) => (isError(value) ? fallback : value)),
    fn('IFNA', [ANY, LAZY], (value, fallback) => (value === NA ? fallback : value)),
    fn('TRUE', [], () => true),
    fn('FALSE', [], () => false),
];
