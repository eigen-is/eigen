// The logical functions. IF, IFERROR and IFNA take their branches lazily, so the branch not taken is never evaluated;
// AND and OR evaluate everything, and an error anywhere in their arguments is their result. In a reference or an
// array they count only numbers and booleans, and with nothing to count they are #VALUE!.

import { Take } from '../eval/walk';
import { NA, VALUE } from '../values/errors';
import { isError } from '../values/value';
import { aggregate, define, LAZY, BOOLEAN as OLD_BOOLEAN, optional, refusal, SCALAR } from './legacy';
import { BOOLEAN, fn } from './registry';

export const LOGICAL = [
    aggregate('AND', Take.Truths, (walk) => {
        let all = true;
        while (walk.next()) for (let i = walk.from; i < walk.to; i += 1) if (walk.num[i] === 0) all = false;
        return walk.count === 0 ? VALUE : all;
    }),
    aggregate('OR', Take.Truths, (walk) => {
        let any = false;
        while (walk.next()) for (let i = walk.from; i < walk.to; i += 1) if (walk.num[i] !== 0) any = true;
        return walk.count === 0 ? VALUE : any;
    }),
    fn('NOT', [BOOLEAN], (truth) => !truth),
    define('IF', [OLD_BOOLEAN, LAZY, optional(LAZY, false)], (args, ctx, node, sheet, row, column) => {
        const test = OLD_BOOLEAN.read(args[0]);
        if (test === undefined) return refusal(args[0]);
        const branch = test ? 1 : 2;
        return ctx.force(args[branch], node.children[branch], sheet, row, column);
    }),
    define('IFERROR', [SCALAR, LAZY], (args, ctx, node, sheet, row, column) =>
        isError(args[0]) ? ctx.force(args[1], node.children[1], sheet, row, column) : args[0],
    ),
    define('IFNA', [SCALAR, LAZY], (args, ctx, node, sheet, row, column) =>
        args[0] === NA ? ctx.force(args[1], node.children[1], sheet, row, column) : args[0],
    ),
    fn('TRUE', [], () => true),
    fn('FALSE', [], () => false),
];
