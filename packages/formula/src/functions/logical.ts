// The logical functions. IF, IFERROR, IFNA and CHOOSE answer with the argument they pick, which is evaluated only
// then; IFS and SWITCH try their pairs in turn and stop at the first that fits; AND and OR take every truth value
// of their arguments, as XOR does, and with nothing to take they are #VALUE!.

import { compareValues } from '../values/compare';
import { NA, VALUE } from '../values/errors';
import { isError } from '../values/value';
import { ANY, BOOLEAN, each, fn, INTEGER, LAZY, LAZY_VALUE, NEXT, optional, PLAIN, rest, TRUTHS } from './registry';

export const LOGICAL = [
    fn('AND', [rest(TRUTHS)], (truths) => (truths.count() === 0 ? VALUE : !truths.holds(0))),
    fn('OR', [rest(TRUTHS)], (truths) => (truths.count() === 0 ? VALUE : truths.min() !== 0 || truths.max() !== 0)),
    fn('XOR', [rest(TRUTHS)], (truths) =>
        truths.count() === 0 ? VALUE : truths.list().filter((truth) => truth !== 0).length % 2 === 1,
    ),
    fn('NOT', [BOOLEAN], (truth) => !truth),
    fn('IF', [BOOLEAN, LAZY, optional(LAZY, false)], (test, then, otherwise) => (test ? then : otherwise)),
    fn('IFERROR', [ANY, LAZY_VALUE], (value, fallback) => (isError(value) ? fallback : value)),
    fn('IFNA', [ANY, LAZY_VALUE], (value, fallback) => (value === NA ? fallback : value)),
    fn('CHOOSE', [INTEGER, rest(LAZY)], (index, choices) => choices[index - 1] ?? VALUE),
    fn('IFS', [each(BOOLEAN), each(LAZY)], (test, result) => (test ? result : NEXT)),
    // A blank is the number 0 here, on either side, so it is not the empty text the = operator takes it for.
    fn('SWITCH', [PLAIN, each(PLAIN), each(LAZY), optional(LAZY, NA)], (value, match, result) =>
        compareValues(value ?? 0, match ?? 0) === 0 ? result : NEXT,
    ),
    fn('TRUE', [], () => true),
    fn('FALSE', [], () => false),
];
