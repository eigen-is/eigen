// The functions that ask what a value is. They take an error as a value, so an error in the cell they look at is
// an answer and not a result.

import { NA } from '../values/errors';
import { define, SCALAR } from './registry';

export const INFORMATION = [
    define('ISBLANK', [SCALAR], (args) => args[0] === null),
    define('ISNUMBER', [SCALAR], (args) => typeof args[0] === 'number'),
    define('NA', [], () => NA),
];
