// The stored-chart codec. A chart is stored as one JSON string or as a field per part, a keyed part on Sheets an entry
// per key, and readChartSpec is the one reader every surface and importer runs: the spec as stored, and the view
// resolved from it. The writers turn a change into only the parts or entries whose text it changed, so a peer's edit
// of another entry stands, and build a new or pasted chart's parts with every keyed part present.

import { isRecord } from '../core/guards';
import type {
    ChartSpec,
    ChartSpecChange,
    ChartSpecKeyedPart,
    ChartSpecPart,
    ChartSpecPartKey,
    ChartSpecTexts,
    SheetChartSpecParts,
    SheetChartSpecWrite,
    StoredChartSpec,
} from '../types/chart';
import { CHART_SPEC_PART_KEY, CHART_SPEC_PARTS } from '../types/chart';
import type { YMapLike } from '../vector/kinds/read-fields';
import { isYMapLike } from '../vector/kinds/read-fields';
import { applyChartSpecChange } from './change';
import type { StoredRecord } from './limits';
import {
    chartPointIndex,
    chartSpecByteCounter,
    exceedsChartSpecBytes,
    exceedsChartSpecDepth,
    isChartSeriesId,
    isChartSpecKey,
    own,
} from './limits';
import { resolveChartSpec } from './resolve';

const PARTS = Object.keys(CHART_SPEC_PARTS).filter((part): part is ChartSpecPart =>
    Object.hasOwn(CHART_SPEC_PARTS, part),
);

const PART_OF_KEY: ReadonlyMap<string, ChartSpecPart> = new Map(PARTS.map((part) => [CHART_SPEC_PART_KEY[part], part]));

function isKeyedPart(part: ChartSpecPart): part is ChartSpecKeyedPart {
    return CHART_SPEC_PARTS[part] > 0;
}

// The fields a Sheets chart holds as a record from its creation on.
export const SHEET_CHART_KEYED_PART_KEYS: ReadonlySet<string> = new Set(
    PARTS.filter(isKeyedPart).map((part) => CHART_SPEC_PART_KEY[part]),
);

// Takes what peers store, a host's record of parts, so the size limit is measured on it. stored is what a writer applies
// a change onto; past the size limit it is empty. A part past the depth limit or no JSON object is absent, a keyed one
// empty, so the other parts still read.
export function readChartSpec(value: Readonly<Record<string, unknown>>): {
    stored: StoredChartSpec;
    spec: ChartSpec | null;
} {
    if (exceedsChartSpecBytes(value)) return { stored: {}, spec: null };
    const stored: StoredRecord = Object.create(null);
    for (const part of PARTS) {
        const raw = value[CHART_SPEC_PART_KEY[part]];
        const read = isKeyedPart(part) ? keyedPart(raw, CHART_SPEC_PARTS[part]) : storedRecord(raw);
        if (read) stored[part] = read;
    }
    return { stored, spec: resolveChartSpec(stored) };
}

// A spec as one string, as the OOXML reader builds one: the resolved view, null past the byte or depth limit.
export function parseChartSpec(value: string): ChartSpec | null {
    const stored = exceedsChartSpecBytes(value) ? undefined : storedRecord(value);
    return stored ? resolveChartSpec(stored) : null;
}

// Every prefixed key's text, as a canvas or a doc stores it and the clipboard carries it, off a host's record or a
// stored Y.Map: a string as stored, whether it parses or not, and a Sheets keyed part's entries joined. A record under a
// key this build doesn't know is left out, since how deep its entries sit is unknown. Null past the byte limit, counted
// as exceedsChartSpecBytes counts, so a forged record of a million keys costs what fits under it.
export function chartSpecTexts(chart: Readonly<Record<string, unknown>> | YMapLike): Record<string, string> | null {
    const read = isYMapLike(chart) ? (key: string) => chart.get(key) : (key: string) => own(chart, key);
    const exceeds = chartSpecByteCounter();
    const texts: Record<string, string> = {};
    for (const key of isYMapLike(chart) ? chart.keys() : Object.keys(chart)) {
        if (!isChartSpecKey(key)) continue;
        const value = read(key);
        if (exceeds(key, value)) return null;
        const part = PART_OF_KEY.get(key);
        if (typeof value === 'string') texts[key] = value;
        else if (part && isKeyedPart(part) && isRecord(value)) {
            texts[key] = JSON.stringify(keyedPart(value, CHART_SPEC_PARTS[part]));
        }
    }
    return texts;
}

// Counted before the parse, which V8's JSON.stringify would recurse through in every writer.
function storedRecord(text: unknown): StoredRecord | undefined {
    if (typeof text !== 'string' || exceedsChartSpecDepth(text)) return undefined;
    try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

// One string on a canvas or in a doc, entries on Sheets joined back by their paths.
function keyedPart(raw: unknown, depth: number): StoredRecord {
    if (typeof raw === 'string') return storedRecord(raw) ?? Object.create(null);
    const part: StoredRecord = Object.create(null);
    for (const [key, text] of Object.entries(isRecord(raw) ? raw : {})) {
        const path = entryPath(key, depth);
        const entry = path ? storedRecord(text) : undefined;
        if (!path || !entry) continue;
        let target = part;
        for (const segment of path.slice(0, -1)) {
            const next = own(target, segment);
            target = isRecord(next) ? next : (target[segment] = Object.create(null));
        }
        target[path[path.length - 1]] = entry;
    }
    return part;
}

// An entry's key is its path below its part: an id, and for a point its index after the last /, since an id holds
// none. Any other key is ignored, so a forged one costs that entry, and is never written.
function entryPath(key: string, depth: number): string[] | null {
    if (depth === 1) return isChartSeriesId(key) ? [key] : null;
    const at = key.lastIndexOf('/');
    const id = key.slice(0, at);
    const index = key.slice(at + 1);
    // With no /, the slices would read '12' as point 12 of series '1'.
    return at > 0 && isChartSeriesId(id) && chartPointIndex(index) !== null ? [id, index] : null;
}

// The parts a change touched, a string each, for a host that stores every part as one: a canvas element or a doc node.
// A part set to the text it has is no write, so it can't undo a peer's edit of another entry in it.
export function chartSpecWrites(
    stored: StoredChartSpec,
    change: ChartSpecChange,
): Partial<Record<ChartSpecPartKey, string>> {
    const next = applyChartSpecChange(stored, change);
    const writes: Partial<Record<ChartSpecPartKey, string>> = {};
    for (const part of PARTS) {
        const before = own(stored, part);
        if (own(next, part) === before) continue;
        const text = partText(withoutOrphans(next, part));
        if (text !== partText(before)) writes[CHART_SPEC_PART_KEY[part]] = text;
    }
    return writes;
}

// The parts and entries a change touched on Sheets. A keyed part is written an entry at a time, never as a record, so
// a peer's write to another entry stands.
export function sheetChartSpecWrites(stored: StoredChartSpec, change: ChartSpecChange): SheetChartSpecWrite[] {
    const next = applyChartSpecChange(stored, change);
    const writes: SheetChartSpecWrite[] = [];
    for (const part of PARTS) {
        const before = own(stored, part);
        if (own(next, part) === before) continue;
        if (!isKeyedPart(part)) {
            const text = partText(own(next, part));
            if (text !== partText(before)) writes.push({ key: CHART_SPEC_PART_KEY[part], value: text });
            continue;
        }
        const key = CHART_SPEC_PART_KEY[part];
        entryWrites(before, withoutOrphans(next, part), CHART_SPEC_PARTS[part], [], (entry, value) =>
            writes.push({ key, entry, value }),
        );
    }
    return writes;
}

// A part a change removed reads as broken, as an empty string does.
function partText(value: unknown): string {
    return value === undefined ? '' : JSON.stringify(value);
}

function entryText(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}

// Writing series or points drops the entries of a series data no longer names, so a deleted series' style goes with
// the next edit of its part. Data without a list of series drops none.
function withoutOrphans(next: StoredChartSpec, part: ChartSpecPart): unknown {
    const value = own(next, part);
    const data = own(next, 'data');
    const series = isRecord(data) ? own(data, 'series') : undefined;
    if ((part !== 'series' && part !== 'points') || !isRecord(value) || !Array.isArray(series)) return value;
    const ids = new Set(series.map((item) => (isRecord(item) ? own(item, 'id') : undefined)));
    return Object.fromEntries(Object.entries(value).filter(([id]) => ids.has(id)));
}

// Each entry depth levels below a keyed part that the change replaced with other text, as its JSON, or null where it is
// gone. What the change didn't touch is the record it was, so the walk skips it.
function entryWrites(
    before: unknown,
    after: unknown,
    depth: number,
    path: string[],
    write: (entry: string, value: string | null) => void,
): void {
    if (before === after) return;
    if (depth === 0) {
        const key = path.join('/');
        const text = entryText(after);
        if (entryPath(key, path.length) && text !== entryText(before)) write(key, text);
        return;
    }
    const from = isRecord(before) ? before : {};
    const to = isRecord(after) ? after : {};
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
        entryWrites(own(from, key), own(to, key), depth - 1, [...path, key], write);
    }
}

// Every part's key with its text, as a host that stores each part as one string holds them.
export function mapChartSpecParts(text: (part: ChartSpecPart) => string): Record<ChartSpecPartKey, string> {
    return {
        specChart: text('chart'),
        specTitle: text('title'),
        specLegend: text('legend'),
        specAxes: text('axes'),
        specPlots: text('plots'),
        specSeries: text('series'),
        specPoints: text('points'),
        specData: text('data'),
    };
}

// A chart's parts as a canvas or a doc stores them: made from a spec, by an insert, an import or a test, or pasted as
// another host's texts, each kept as it came and a newer build's part with them. Every part is there, a keyed one {}
// when it has no entries, one the texts lack '' and a keyed one {}.
export function newChartSpecParts(from: ChartSpec | ChartSpecTexts): Record<ChartSpecPartKey, string> {
    if (isChartSpec(from)) return mapChartSpecParts((part) => JSON.stringify(from[part]));
    const text = (part: ChartSpecPart) => from[CHART_SPEC_PART_KEY[part]] ?? (isKeyedPart(part) ? '{}' : '');
    return { ...from, ...mapChartSpecParts(text) };
}

// The same on Sheets, where every keyed part is a record from the start: a recipe that made one and set an entry in it
// would ship the record whole, and two peers' first entries would collide. A pasted keyed part's text is split into its
// entries, so one that doesn't parse has none; every other text is kept as it came.
export function newSheetChartSpecParts(from: ChartSpec | ChartSpecTexts): SheetChartSpecParts {
    const spec = isChartSpec(from) ? from : null;
    const texts: ChartSpecTexts = isChartSpec(from) ? {} : from;
    const text = (part: ChartSpecPart) =>
        spec ? JSON.stringify(spec[part]) : (texts[CHART_SPEC_PART_KEY[part]] ?? '');
    const entries = (part: ChartSpecKeyedPart) => {
        const record: Record<string, string> = {};
        const value = spec ? spec[part] : storedRecord(texts[CHART_SPEC_PART_KEY[part]]);
        entryWrites(undefined, value, CHART_SPEC_PARTS[part], [], (entry, written) => {
            if (written !== null) record[entry] = written;
        });
        return record;
    };
    return {
        ...texts,
        specChart: text('chart'),
        specTitle: text('title'),
        specLegend: text('legend'),
        specAxes: entries('axes'),
        specPlots: entries('plots'),
        specSeries: entries('series'),
        specPoints: entries('points'),
        specData: text('data'),
    };
}

// A spec's parts are values; texts hold strings only.
function isChartSpec(from: ChartSpec | ChartSpecTexts): from is ChartSpec {
    return isRecord(from['chart']);
}
