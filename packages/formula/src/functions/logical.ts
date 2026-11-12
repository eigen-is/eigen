// The logical functions. IF, IFERROR and IFNA answer with the branch they pick, which is evaluated only then; IFS
// and SWITCH try their pairs in turn and stop at the first that fits; AND and OR take every truth value of their
// arguments, and with nothing to take they are #VALUE!.

import { compareValues } from '../values/compare';
import { NA, VALUE } from '../values/errors';
import { isError } from '../values/value';
import { ANY, BOOLEAN, each, fn, INTEGER, LAZY, NEXT, optional, PLAIN, rest, TRUTHS } from './registry';

export const LOGICAL = [
    fn('AND', [rest(TRUTHS)], (truths) => (truths.count() === 0 ? VALUE : !truths.holds(0))),
    fn('OR', [rest(TRUTHS)], (truths) => (truths.count() === 0 ? VALUE : truths.min() !== 0 || truths.max() !== 0)),
    fn('NOT', [BOOLEAN], (truth) => !truth),
    fn('IF', [BOOLEAN, LAZY, optional(LAZY, false)], (test, then, otherwise) => (test ? then : otherwise)),
    fn('IFERROR', [ANY, LAZY], (value, fallback) => (isError(value) ? fallback : value)),
    fn('IFNA', [ANY, LAZY], (value, fallback) => (value === NA ? fallback : value)),
    fn('CHOOSE', [INTEGER, rest(LAZY)], (index, choices) => choices[index - 1] ?? VALUE),
    fn('IFS', [each(BOOLEAN), each(LAZY)], (test, result) => (test ? result : NEXT)),
    fn('SWITCH', [PLAIN, each(PLAIN), each(LAZY), optional(LAZY, NA)], (value, match, result) =>
        compareValues(value, match) === 0 ? result : NEXT,
    ),
    fn('TRUE', [], () => true),
    fn('FALSE', [], () => false),
];
