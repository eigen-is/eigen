// The one rule for merging a settings change into the settings. The server uses it when it saves a
// change, and the browser uses it to draw the change before the server answers, so both agree.
// Two records merge field by field, at any depth. Any other value, an array for example, replaces
// what was there. It builds a new object and leaves both inputs as they were.

import type { DeepPartial } from '../types/util';
import { isRecord } from './guards';

// The merge itself only sees untyped records. This public signature says the result keeps the
// target's type, which holds because the change only has fields the target's type allows.
export function deepMerge<T extends Record<string, unknown>>(target: T, source: DeepPartial<T>): T;
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    return mergeRecords(target, source);
}

// The recursion can't call deepMerge: only its public signature is visible, and a nested record
// of unknown values is not a DeepPartial of itself.
function mergeRecords(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
        const current = result[key];
        result[key] = isRecord(value) && isRecord(current) ? mergeRecords(current, value) : value;
    }
    return result;
}
