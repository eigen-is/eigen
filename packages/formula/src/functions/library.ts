// Every function this build evaluates, by its upper-cased name: the one list the engine looks a call up in. A
// name that is not here evaluates to #NAME?.

import { DATE_TIME } from './date-time';
import { INFORMATION } from './information';
import { LOGICAL } from './logical';
import { LOOKUP } from './lookup';
import { MATH } from './math';
import type { Registry } from './registry';
import { STATISTICAL } from './statistical';
import { TEXT_FUNCTIONS } from './text';

export const FUNCTIONS: Registry = new Map(
    [...DATE_TIME, ...INFORMATION, ...LOGICAL, ...LOOKUP, ...MATH, ...STATISTICAL, ...TEXT_FUNCTIONS].map((entry) => [
        entry.name,
        entry,
    ]),
);
