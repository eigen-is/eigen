// The bounds on what one stored chart may hold. Every peer lays out and paints whatever any peer or a paste stores,
// so these limits bound a chart's cost: its size, nesting depth, series and points, and the side of its box. They
// also give the grammar of a chart's keys, such as a series id or a point's index, so a forged key can never reach
// what a plain object inherits. The reader checks them before it parses, and the editors before they write.

import { nanoid } from 'nanoid';
import { isRecord } from '../core/guards';
import { MAX_PAPER_MM, mmToPx } from '../docs/eigendoc/page';
import type { InlineChartData, StoredChartSpec } from '../types/chart';

export const MAX_CHART_SPEC_BYTES = 64 * 1024;
// Levels of [ and {, far past what Eigen writes: V8's JSON.stringify recurses, and throws at about 8,000 levels in
// every writer that serializes what is stored.
export const MAX_CHART_SPEC_DEPTH = 32;
// Entries one Sheets chart holds, its records' keys summed. The shortest entry a build writes, a one-character id at
// '{}', is three bytes, so a chart holding more is past the byte limit and reads as nothing anyway.
export const MAX_CHART_SPEC_ENTRIES = Math.floor(MAX_CHART_SPEC_BYTES / 3);
export const MAX_CHART_SERIES = 32;
// Range data counts its points when the sheet resolves it, since a selection can outgrow the limit.
export const MAX_CHART_POINTS = 2000;
export const MAX_CHART_LABEL_LENGTH = 200;
// No chart is drawn wider or taller than the largest page, Word's 22 inches (2112 px): a side past it runs the layout
// for seconds in every viewer and the export, and at a trillion px overflows the painter's stack.
export const CHART_MAX_SIDE = Math.round(mmToPx(MAX_PAPER_MM));

// What the Edit data grid edits; an imported chart over these opens its data read-only. A full grid,
// 12 × 200, is past MAX_CHART_POINTS, so the grid's cells count too.
export const INLINE_GRID_MAX_SERIES = 12;
export const INLINE_GRID_MAX_CATEGORIES = 200;

export function fitsInlineGrid(series: number, rows: number): boolean {
    return series <= INLINE_GRID_MAX_SERIES && rows <= INLINE_GRID_MAX_CATEGORIES && series * rows <= MAX_CHART_POINTS;
}

// The grid pads every series to the longest, so a ragged chart counts as its full grid.
export function exceedsInlineGridLimits(data: InlineChartData): boolean {
    const rows = Math.max(data.categories.length, ...data.series.map((series) => series.values.length));
    return !fitsInlineGrid(data.series.length, rows);
}

// Ids are the grammar of nanoid's alphabet, and never a name a plain object inherits, so a record keyed by them is
// safe to build.
const CHART_SERIES_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const INHERITED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isChartSeriesId(id: string): boolean {
    return CHART_SERIES_ID.test(id) && !INHERITED_KEYS.has(id);
}

export function newChartSeriesId(): string {
    return `s-${nanoid(10)}`;
}

// A point's key is its index as a canonical decimal under the point limit, so '03' or '1e3' names no point.
export function chartPointIndex(key: string): number | null {
    return /^(0|[1-9]\d*)$/.test(key) && Number(key) < MAX_CHART_POINTS ? Number(key) : null;
}

// A host's record names a chart's parts by spec and a capital, this build's parts and a newer one's.
export function isChartSpecKey(key: string): boolean {
    return /^spec[A-Z]/.test(key);
}

export type StoredRecord = { [key: string]: unknown };

// A record's own key only: an id such as 'toString' must not read what every object inherits.
export function own(target: StoredChartSpec, key: string): unknown {
    return Object.hasOwn(target, key) ? target[key] : undefined;
}

// A stored string, or on a host's record every prefixed key's name and text summed, known or not, a Sheets entry's key
// and text both. The count stops at the limit, so a forged record of a million keys or entries costs what fits under it.
export function exceedsChartSpecBytes(value: string | Readonly<Record<string, unknown>>): boolean {
    if (typeof value === 'string') return byteBudget()(value);
    const exceeds = chartSpecByteCounter();
    return Object.keys(value).some((key) => isChartSpecKey(key) && exceeds(key, value[key]));
}

// The same count one prefixed key at a time, for a host that collects its keys in the pass that counts them: true once
// the keys so far are past the limit.
export function chartSpecByteCounter(): (key: string, part: unknown) => boolean {
    const spend = byteBudget();
    return (key, part) => {
        if (spend(key)) return true;
        if (typeof part === 'string') return spend(part);
        return (
            isRecord(part) &&
            Object.keys(part).some((entry) => {
                const text = part[entry];
                return spend(entry) || (typeof text === 'string' && spend(text));
            })
        );
    };
}

const ENCODER = new TextEncoder();

function byteBudget(): (text: string) => boolean {
    let left = MAX_CHART_SPEC_BYTES;
    return (text) => {
        // Every UTF-16 unit is a UTF-8 byte or more, so a string longer than what is left is past it unencoded.
        left -= text.length > left ? left + 1 : ENCODER.encode(text).length;
        return left < 0;
    };
}

// Counted on the string, in one pass before the parse; a bracket inside a JSON string is text.
export function exceedsChartSpecDepth(value: string): boolean {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (const char of value) {
        if (escaped) escaped = false;
        else if (quoted) {
            if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '[' || char === '{') depth += 1;
        else if (char === ']' || char === '}') depth -= 1;
        if (depth > MAX_CHART_SPEC_DEPTH) return true;
    }
    return false;
}
