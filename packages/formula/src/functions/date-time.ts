// The functions on dates and times. A date is a serial number, so each of them is arithmetic on whole days, and
// the one that asks what time it is gets that from the pass, never from the machine it runs on.

import { addMonths } from '../values/dates';
import { fn, INTEGER, NOW, SERIAL, strict } from './registry';

export const DATE_TIME = [fn('EDATE', [strict(SERIAL), strict(INTEGER)], addMonths), fn('NOW', [NOW], (now) => now)];
