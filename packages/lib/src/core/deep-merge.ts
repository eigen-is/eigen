// The one rule for merging a settings change into the settings. Callers such as the server's settings
// store, when it saves a change, and a hook that draws a change before the server answers use it, so
// both agree. Two records merge field by field, at any depth. Any other value, an array for example,
// replaces what was there. A field set to undefined replaces the old value here, while JSON drops it on
// the way to the server. It builds a new object and leaves both inputs as they were.

import type { DeepPartial } from '../types/util';
import { isRecord } from './guards';

export function deepMerge<T extends Record<string, unknown>>(target: T, source: DeepPartial<T>): T {
    const result: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries<unknown>(source)) {
        const current = result[key];
        result[key] = isRecord(value) && isRecord(current) ? deepMerge(current, value) : value;
    }
    // The recursion only sees untyped records, so this is the one place the result is called a T.
    return result as T;
}
