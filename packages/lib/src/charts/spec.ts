// The stored-chart codec. Every host stores a chart as eight JSON strings, a field per part, such as a canvas element,
// a doc's node or a sheet's chart. readChartSpec is the one reader every surface and importer runs, and it gives the
// spec as stored and the view resolved from it. chartSpecWrites turns a change into only the parts whose text it
// changed, and newChartSpecParts builds a new or pasted chart's parts.

import { isRecord } from '../core/guards';
import type {
    ChartSpec,
    ChartSpecChange,
    ChartSpecPart,
    ChartSpecPartKey,
    ChartSpecTexts,
    StoredChartSpec,
} from '../types/chart';
import { CHART_SPEC_PART_KEY, CHART_SPEC_PART_KEYS, CHART_SPEC_PARTS } from '../types/chart';
import type { YMapLike } from '../vector/kinds/read-fields';
import { isYMapLike } from '../vector/kinds/read-fields';
import { applyChartSpecChange } from './change';
import type { StoredRecord } from './limits';
import { exceedsChartSpecBytes, exceedsChartSpecDepth, own } from './limits';
import { resolveChartSpec } from './resolve';

// Reads the eight parts off a host's record, which is what peers store, so the size limit is measured on it. `stored`
// is what a writer applies a change onto: empty past the size limit, and without a part that is no JSON object.
export function readChartSpec(value: Readonly<Record<string, unknown>>): {
    stored: StoredChartSpec;
    spec: ChartSpec | null;
} {
    if (exceedsChartSpecBytes(value)) return { stored: {}, spec: null };
    const stored: StoredRecord = Object.create(null);
    for (const part of CHART_SPEC_PARTS) {
        const read = storedRecord(value[CHART_SPEC_PART_KEY[part]]);
        if (read) stored[part] = read;
    }
    return { stored, spec: resolveChartSpec(stored) };
}

// A spec as one string, as the OOXML reader builds one: the resolved view, null past the byte or depth limit.
export function parseChartSpec(value: string): ChartSpec | null {
    const stored = exceedsChartSpecBytes(value) ? undefined : storedRecord(value);
    return stored ? resolveChartSpec(stored) : null;
}

// Each part's text off a host's record or a stored Y.Map, as the clipboard carries it. A string is kept as stored,
// whether it parses or not, and a part that is no string is left out. Null past the byte limit.
export function chartSpecTexts(chart: Readonly<Record<string, unknown>> | YMapLike): ChartSpecTexts | null {
    const texts: { [K in ChartSpecPartKey]?: string } = {};
    for (const key of CHART_SPEC_PART_KEYS) {
        const text = isYMapLike(chart) ? chart.get(key) : chart[key];
        if (typeof text === 'string') texts[key] = text;
    }
    return exceedsChartSpecBytes(texts) ? null : texts;
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

// The parts a change touched, a string each. A part set to the text it has is no write, so it can't undo a peer's
// edit of that part.
export function chartSpecWrites(
    stored: StoredChartSpec,
    change: ChartSpecChange,
): Partial<Record<ChartSpecPartKey, string>> {
    const next = applyChartSpecChange(stored, change);
    const writes: Partial<Record<ChartSpecPartKey, string>> = {};
    for (const part of CHART_SPEC_PARTS) {
        const before = own(stored, part);
        if (own(next, part) === before) continue;
        const text = partText(withoutOrphans(next, part));
        if (text !== partText(before)) writes[CHART_SPEC_PART_KEY[part]] = text;
    }
    return writes;
}

// A part a change removed reads as broken, as an empty string does.
function partText(value: unknown): string {
    return value === undefined ? '' : JSON.stringify(value);
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

// A chart's parts as a host stores them, made from a spec or from the texts a copy carries, which are kept as they
// came. Every part is there: one the texts lack is '', which reads as missing.
export function newChartSpecParts(from: ChartSpec | ChartSpecTexts): Record<ChartSpecPartKey, string> {
    return 'chart' in from
        ? mapChartSpecParts((part) => JSON.stringify(from[part]))
        : mapChartSpecParts((part) => from[CHART_SPEC_PART_KEY[part]] ?? '');
}

// Spelled out, so each key types as its own.
function mapChartSpecParts(text: (part: ChartSpecPart) => string): Record<ChartSpecPartKey, string> {
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
