// The functions that ask what a value is. They take an error as a value, so an error in the cell they look at is
// an answer and not a result.

import { NA } from '../values/errors';
import { isError } from '../values/value';
import { ANY, fn } from './registry';

export const INFORMATION = [
    fn('ISBLANK', [ANY], (value) => value === null),
    fn('ISERROR', [ANY], isError),
    fn('ISNUMBER', [ANY], (value) => typeof value === 'number'),
    fn('ISTEXT', [ANY], (value) => typeof value === 'string'),
    fn('NA', [], () => NA),
];
