// Every function this build evaluates, by its upper-cased name: the one list the engine looks a call up in. A
// name that is not here evaluates to #NAME?.

import { INFORMATION } from './information';
import { LOGICAL } from './logical';
import { LOOKUP } from './lookup';
import { MATH } from './math';
import type { Registry } from './registry';
import { TEXT } from './text';

export const FUNCTIONS: Registry = new Map(
    [...INFORMATION, ...LOGICAL, ...LOOKUP, ...MATH, ...TEXT].map((entry) => [entry.name, entry]),
);
