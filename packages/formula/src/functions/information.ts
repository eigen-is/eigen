// The functions that ask what a value is. They take an error as a value, so an error in the cell they look at is
// an answer and not a result.

import { NA } from '../values/errors';
import { isError } from '../values/value';
import { ANY, define, scalar1 } from './registry';

export const INFORMATION = [
    scalar1('ISBLANK', ANY, (value) => value === null),
    scalar1('ISERROR', ANY, (value) => isError(value)),
    scalar1('ISNUMBER', ANY, (value) => typeof value === 'number'),
    scalar1('ISTEXT', ANY, (value) => typeof value === 'string'),
    define('NA', [], () => NA),
];
