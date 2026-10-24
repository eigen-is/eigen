// The stored-chart codec. A chart is stored as one JSON string or as a field per part, a keyed part on Sheets an entry
// per key, and readChartSpec is the one reader every surface and importer runs: the spec as stored, and the view
// resolved from it. Malformed structure or a hard limit resolves as null, never a throw; a presentation field reads its
// default. An edit is a change applied onto what is stored, so the keys and values this build doesn't know survive
// it, and a host writes only the parts or entries it touched.

import { isEqual } from 'es-toolkit';
import { nanoid } from 'nanoid';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '../constants/colors';
import { DOCUMENT_FONT } from '../constants/fonts';
import { isRecord } from '../core/guards';
import { stripNonXmlChars } from '../core/xml';
import { MAX_PAPER_MM, mmToPx } from '../docs/eigendoc/page';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '../sheets/defaults';
import type {
    CellRangeRef,
    ChartAxis,
    ChartAxisId,
    ChartPoint,
    ChartSeriesStyle,
    ChartSpec,
    ChartSpecChange,
    ChartSpecKeyedPart,
    ChartSpecOp,
    ChartSpecPart,
    ChartSpecPartKey,
    ChartType,
    InlineChartData,
    InlineChartSeries,
    RangeChartData,
    RangeChartSeries,
    SheetChartSpecParts,
    SheetChartSpecWrite,
    StoredChartSpec,
} from '../types/chart';
import {
    CHART_AXIS_KINDS,
    CHART_BLANKS,
    CHART_SPEC_PART_KEY,
    CHART_SPEC_PARTS,
    CHART_STACKINGS,
    CHART_TYPES,
    LEGEND_POSITIONS,
} from '../types/chart';
import { bool, color, fontFamily, oneOf, str } from '../vector/kinds/read-fields';
import { prop } from '../vector/types';

// Hard limits: every peer lays out and paints whatever is stored, so they bound one chart's cost.
// Range data counts its points when the sheet resolves it, since a selection can outgrow the limit.
export const MAX_CHART_SPEC_BYTES = 64 * 1024;
// Levels of [ and {, far past what Eigen writes: V8's JSON.stringify recurses, and throws at about 8,000 levels in
// every writer that serializes what is stored.
export const MAX_CHART_SPEC_DEPTH = 32;
export const MAX_CHART_SERIES = 32;
export const MAX_CHART_POINTS = 2000;
export const MAX_CHART_LABEL_LENGTH = 200;
// Google's inserted chart, which fits the default page's 642 px text column.
export const CHART_DEFAULT_SIZE = { width: 600, height: 371 };
// No chart is drawn wider or taller than the largest page, Word's 22 inches (2112 px): a side past it runs the layout
// for seconds in every viewer and the export, and at a trillion px overflows the painter's stack.
export const CHART_MAX_SIDE = Math.round(mmToPx(MAX_PAPER_MM));

// What the Edit data grid edits; an imported chart over these opens its data read-only. A full grid,
// 12 × 200, is past MAX_CHART_POINTS, so the grid's cells count too.
export const INLINE_GRID_MAX_SERIES = 12;
export const INLINE_GRID_MAX_CATEGORIES = 200;

// Google's chart font, and the one a spec that names none or a font Eigen doesn't bundle reads as.
export const DEFAULT_CHART_FONT = DOCUMENT_FONT;

// The accent colors in the order calendars hand them out, so the first few series and every neighbor stay apart, for a
// color-blind reader too.
// A series or slice whose color is null draws in the one at its index.
export function chartColor(index: number): string {
    return EIGEN_ACCENT_COLORS_SHUFFLED[index % EIGEN_ACCENT_COLORS_SHUFFLED.length].value;
}

export function fitsInlineGrid(series: number, rows: number): boolean {
    return series <= INLINE_GRID_MAX_SERIES && rows <= INLINE_GRID_MAX_CATEGORIES && series * rows <= MAX_CHART_POINTS;
}

// The grid pads every series to the longest, so a ragged chart counts as its full grid.
export function exceedsInlineGridLimits(data: InlineChartData): boolean {
    const rows = Math.max(data.categories.length, ...data.series.map((series) => series.values.length));
    return !fitsInlineGrid(data.series.length, rows);
}

// Google's axes: a category axis without gridlines and a value axis with them, both shown, neither bounded.
const DEFAULT_AXES: ChartSpec['axes'] = {
    x: {
        kind: 'category',
        title: { text: '' },
        visible: true,
        gridlines: { visible: false },
        labels: { format: null },
        scale: { min: null, max: null, reversed: false },
    },
    y: {
        kind: 'value',
        title: { text: '' },
        visible: true,
        gridlines: { visible: true },
        labels: { format: null },
        scale: { min: null, max: null, reversed: false },
    },
};

// What a new chart of this data starts from and what a missing or invalid field reads as, so a field added later reads
// its default from charts stored before it.
export function defaultChartSpec(type: ChartType, data: ChartSpec['data']): ChartSpec {
    const plot = { stacking: 'none' } as const;
    return {
        chart: { type, blanks: 'gap', fontFamily: DEFAULT_CHART_FONT },
        title: { text: '' },
        legend: { position: type === 'pie' ? 'none' : 'top' },
        axes: DEFAULT_AXES,
        plots: { column: plot, bar: plot, line: plot, pie: plot },
        series: Object.fromEntries(data.series.map(({ id }) => [id, DEFAULT_CHART_SERIES_STYLE])),
        points: {},
        data,
    };
}

// Ids are the grammar of nanoid's alphabet, and never a name a plain object inherits, so a record keyed by them is
// safe to build.
const CHART_SERIES_ID = /^[A-Za-z0-9_-]{1,64}$/;
const INHERITED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isChartSeriesId(id: string): boolean {
    return CHART_SERIES_ID.test(id) && !INHERITED_KEYS.has(id);
}

export function newChartSeriesId(): string {
    return `s-${nanoid(10)}`;
}

// A new series, made in Eigen: in the chart's type on its value axis, its color automatic, so the palette colors it by
// position.
export const DEFAULT_CHART_SERIES_STYLE: ChartSeriesStyle = {
    plot: null,
    yAxis: 'y' satisfies ChartAxisId,
    color: null,
    line: { smooth: false },
    marker: { visible: false },
};

// A series' style by its id, a new series' for one a spec built in memory doesn't style.
export function chartSeriesStyle(spec: Pick<ChartSpec, 'series'>, id: string): ChartSeriesStyle {
    return Object.hasOwn(spec.series, id) ? spec.series[id] : DEFAULT_CHART_SERIES_STYLE;
}

// A point's own color, null for one that takes its series' or the palette's.
export function chartPointColor(spec: Pick<ChartSpec, 'points'>, id: string, index: number): string | null {
    const points = Object.hasOwn(spec.points, id) ? spec.points[id] : null;
    return points && Object.hasOwn(points, index) ? points[index].color : null;
}

// A point's key is its index as a canonical decimal under the point limit, so '03' or '1e3' names no point.
export function chartPointIndex(key: string): number | null {
    return /^(0|[1-9]\d*)$/.test(key) && Number(key) < MAX_CHART_POINTS ? Number(key) : null;
}

// The ops that take every stored point, of the series this build reads and the ones it doesn't, from its index to
// target(index), null removing it, for a remap that keeps their order (a row op, Edit data's deleted rows). Per series
// the moves down run first from the lowest target, those up last from the highest, so none lands on a point still to
// move.
export function chartPointMoves(stored: StoredChartSpec, target: (index: number) => number | null): ChartSpecOp[] {
    const points = stored['points'];
    if (!isRecord(points)) return [];
    return Object.entries(points).flatMap(([id, entries]) => {
        if (!isRecord(entries)) return [];
        const path = (index: number) => ['points', id, String(index)];
        const removes: ChartSpecOp[] = [];
        const down: [number, number][] = [];
        const up: [number, number][] = [];
        for (const key of Object.keys(entries)) {
            const index = chartPointIndex(key);
            if (index === null) continue;
            const to = target(index);
            if (to === null) removes.push({ op: 'remove', path: path(index) });
            else if (to < index) down.push([index, to]);
            else if (to > index) up.push([index, to]);
        }
        down.sort((a, b) => a[1] - b[1]);
        up.sort((a, b) => b[1] - a[1]);
        return [
            ...removes,
            ...[...down, ...up].map(([from, to]): ChartSpecOp => ({ op: 'move', from: path(from), path: path(to) })),
        ];
    });
}

// Insert → Chart's sample, one dataset for every type since the Type switch keeps the data: the share of a source's
// light per 100 nm bin from 300 to 1000 nm, Planck's law at 5772 K (Sun), 2700 K (bulb) and 10000 K (hot star), each
// source summing to 100, so the bars compare and the peak moves with temperature. A pie draws the Sun. Its labels draw in
// the host's font.
export function sampleChartSpec(type: ChartType, fontFamily = DEFAULT_CHART_FONT): ChartSpec {
    const categories = ['300–400', '400–500', '500–600', '600–700', '700–800', '800–900', '900–1000'];
    const sources = [
        { name: 'Sun', values: [13.1, 18.3, 18.6, 16.5, 13.7, 11.0, 8.8] },
        { name: 'Bulb (incandescent)', values: [0.3, 2.5, 7.5, 14.3, 20.9, 25.8, 28.7] },
        { name: 'Hot star', values: [32.4, 23.8, 16.2, 11.0, 7.5, 5.3, 3.8] },
    ];
    const defaults = defaultChartSpec(type, {
        source: 'inline',
        categories,
        series: (type === 'pie' ? sources.slice(0, 1) : sources).map((source, i) => ({ ...source, id: `s-${i + 1}` })),
    });
    const { x, y } = defaults.axes;
    return {
        ...defaults,
        chart: { ...defaults.chart, fontFamily },
        title: { text: "Where a star's light goes" },
        axes: {
            x: { ...x, title: { text: 'Wavelength (nm)' } },
            y: { ...y, title: { text: 'Share of light, 300–1000 nm (%)' } },
        },
    };
}

// A host's record names a chart's parts by spec and a capital, this build's parts and a newer one's.
export function isChartSpecKey(key: string): boolean {
    return /^spec[A-Z]/.test(key);
}

const ENCODER = new TextEncoder();

// A stored string, or on a host's record every prefixed key's name and text summed, known or not, a Sheets entry's key
// and text both. The count stops at the limit, so a forged record of a million keys or entries costs what fits under it.
export function exceedsChartSpecBytes(value: string | object): boolean {
    let left = MAX_CHART_SPEC_BYTES;
    // Every UTF-16 unit is a UTF-8 byte or more, so a string longer than what is left is past it unencoded.
    const spend = (text: string) => {
        left -= text.length > left ? left + 1 : ENCODER.encode(text).length;
        return left < 0;
    };
    if (typeof value === 'string') return spend(value);
    return Object.keys(value).some((key) => {
        if (!isChartSpecKey(key)) return false;
        const part = prop(value, key);
        if (spend(key)) return true;
        if (typeof part === 'string') return spend(part);
        return (
            isRecord(part) &&
            Object.keys(part).some((entry) => {
                const text = part[entry];
                return spend(entry) || (typeof text === 'string' && spend(text));
            })
        );
    });
}

// Counted on the string, in one pass before the parse; a bracket inside a JSON string is text.
function exceedsChartSpecDepth(value: string): boolean {
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

// What a search finds a chart by: its titles, series names and inline categories, a line each.
export function chartSearchText(spec: ChartSpec | null): string {
    if (!spec) return '';
    const { data } = spec;
    return [
        spec.title.text,
        spec.axes.x.title.text,
        spec.axes.y.title.text,
        ...data.series.flatMap((series) => (typeof series.name === 'string' ? [series.name] : [])),
        ...(data.source === 'inline' ? data.categories : []),
    ]
        .filter((text) => text !== '')
        .join('\n');
}

// Takes what peers store, one string or a host's record of parts, so the size limit is measured on it. stored is what a
// writer applies a change onto and a copy carries; past the size limit it is empty. A string past the depth limit or no
// JSON object is empty too; on a record such a part is absent, a keyed one empty, so the other parts still read.
export function readChartSpec(value: string | object): { stored: StoredChartSpec; spec: ChartSpec | null } {
    if (exceedsChartSpecBytes(value)) return { stored: {}, spec: null };
    if (typeof value === 'string') {
        const stored = storedRecord(value);
        return stored ? { stored, spec: resolved(stored) } : { stored: {}, spec: null };
    }
    const stored: StoredRecord = Object.create(null);
    for (const part of PARTS) {
        const raw = prop(value, CHART_SPEC_PART_KEY[part]);
        const read = isKeyedPart(part) ? keyedPart(raw, CHART_SPEC_PARTS[part]) : storedRecord(raw);
        if (read) stored[part] = read;
    }
    return { stored, spec: resolved(stored) };
}

const PARTS = Object.keys(CHART_SPEC_PARTS).filter((part): part is ChartSpecPart =>
    Object.hasOwn(CHART_SPEC_PARTS, part),
);

const isKeyedPart = (part: ChartSpecPart): part is ChartSpecKeyedPart => CHART_SPEC_PARTS[part] > 0;

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
    return at > 0 && isChartSeriesId(id) && chartPointIndex(index) !== null ? [id, index] : null;
}

// One catch for every field reader's invalid(), so the readers stay straight-line.
function resolved(stored: StoredChartSpec): ChartSpec | null {
    try {
        return chartSpec(stored);
    } catch {
        return null;
    }
}

export function parseChartSpec(value: string): ChartSpec | null {
    return readChartSpec(value).spec;
}

// Edit data rebuilds the data from the keys this build reads, so a key it doesn't (a newer build's array beside a
// series' values) would fall out of step with them: such a chart's data is shown, not edited.
export function holdsUnknownChartData(stored: StoredChartSpec, spec: ChartSpec): boolean {
    const known = (item: unknown, read: object) =>
        isRecord(item) && Object.keys(item).every((key) => Object.hasOwn(read, key));
    const data = isRecord(stored['data']) ? stored['data'] : {};
    const series = Array.isArray(data['series']) ? data['series'] : [];
    return !known(data, spec.data) || series.some((item, i) => !known(item, spec.data.series[i]));
}

// Edit data's Save, the one editor that diffs: the leaves the dialog changed from the spec it opened with, so a peer's
// edit meanwhile stands. Records are walked, arrays compared whole.
export function chartSpecChange(base: ChartSpec, next: ChartSpec): ChartSpecChange {
    const leaves = (before: unknown, after: unknown, path: string[]): ChartSpecOp[] => {
        if (isEqual(before, after)) return [];
        if (!isRecord(before) || !isRecord(after)) return [{ op: 'set', path, value: after }];
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        return [...keys].flatMap((key): ChartSpecOp[] =>
            Object.hasOwn(after, key)
                ? leaves(before[key], after[key], [...path, key])
                : [{ op: 'remove', path: [...path, key] }],
        );
    };
    return leaves(base, next, []);
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

// A chart made from nothing, by an insert, an import or a test: every part, a keyed one {} when it has no entries.
export function newChartSpecParts(spec: ChartSpec): Record<ChartSpecPartKey, string> {
    return {
        specChart: JSON.stringify(spec.chart),
        specTitle: JSON.stringify(spec.title),
        specLegend: JSON.stringify(spec.legend),
        specAxes: JSON.stringify(spec.axes),
        specPlots: JSON.stringify(spec.plots),
        specSeries: JSON.stringify(spec.series),
        specPoints: JSON.stringify(spec.points),
        specData: JSON.stringify(spec.data),
    };
}

// The same on Sheets, where every keyed part is a record from the start: a recipe that made one and set an entry in it
// would ship the record whole, and two peers' first entries would collide.
export function newSheetChartSpecParts(spec: ChartSpec): SheetChartSpecParts {
    const entries = (part: ChartSpecKeyedPart) => {
        const record: Record<string, string> = {};
        entryWrites(undefined, spec[part], CHART_SPEC_PARTS[part], [], (entry, value) => {
            if (value !== null) record[entry] = value;
        });
        return record;
    };
    return {
        specChart: JSON.stringify(spec.chart),
        specTitle: JSON.stringify(spec.title),
        specLegend: JSON.stringify(spec.legend),
        specAxes: entries('axes'),
        specPlots: entries('plots'),
        specSeries: entries('series'),
        specPoints: entries('points'),
        specData: JSON.stringify(spec.data),
    };
}

// A part a change removed reads as broken, as an empty string does.
const partText = (value: unknown) => (value === undefined ? '' : JSON.stringify(value));
const entryText = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

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

// The stored spec with a change applied, sharing what it didn't touch. Every record it makes or copies has no
// prototype, and an op whose path names a key a plain object inherits is dropped, so a forged key can't reach
// Object.prototype.
export function applyChartSpecChange(stored: StoredChartSpec, change: ChartSpecChange): StoredChartSpec {
    const made: Made = new WeakMap();
    let next = stored;
    for (const op of change) {
        const paths = op.op === 'move' ? [op.from, op.path] : [op.path];
        if (paths.some((path) => path.length === 0 || path.some((key) => INHERITED_KEYS.has(key)))) continue;
        if (op.op === 'set') next = setIn(next, op.path, op.value, made);
        else if (op.op === 'remove') next = removeIn(next, op.path, made);
        else {
            const moved = getIn(next, op.from);
            next = removeIn(removeIn(next, op.from, made), op.path, made);
            if (moved !== undefined) next = setIn(next, op.path, moved, made);
        }
    }
    return next;
}

type StoredRecord = { [key: string]: unknown };
// The records one apply made, each keyed by itself, so a later op of that apply writes into one in place: N moves
// within a series' points copy its record once, not N times.
type Made = WeakMap<StoredChartSpec, StoredRecord>;

const own = (target: StoredChartSpec, key: string): unknown => (Object.hasOwn(target, key) ? target[key] : undefined);

function writable(target: StoredChartSpec, made: Made): StoredRecord {
    const mine = made.get(target);
    if (mine) return mine;
    const next: StoredRecord = Object.assign(Object.create(null), target);
    made.set(next, next);
    return next;
}

function getIn(target: StoredChartSpec, [key, ...rest]: string[]): unknown {
    const value = own(target, key);
    if (rest.length === 0) return value;
    return isRecord(value) ? getIn(value, rest) : undefined;
}

function setIn(target: StoredChartSpec, [key, ...rest]: string[], value: unknown, made: Made): StoredChartSpec {
    const before = own(target, key);
    const next = writable(target, made);
    if (rest.length > 0) next[key] = setIn(isRecord(before) ? before : Object.create(null), rest, value, made);
    else next[key] = laidOver(before, value);
    return next;
}

function removeIn(target: StoredChartSpec, [key, ...rest]: string[], made: Made): StoredChartSpec {
    const before = own(target, key);
    if (before === undefined) return target;
    if (rest.length > 0) {
        const removed = isRecord(before) ? removeIn(before, rest, made) : before;
        return removed === before ? target : setIn(target, [key], removed, made);
    }
    const next = writable(target, made);
    delete next[key];
    return next;
}

// A list of records with ids (data.series) is set whole, each item laid over the stored item with its id, so the keys
// a newer build stored on a series survive this one's edit.
function laidOver(before: unknown, value: unknown): unknown {
    if (!Array.isArray(before) || !Array.isArray(value)) return value;
    const idOf = (item: unknown) => (isRecord(item) ? own(item, 'id') : undefined);
    const stored = new Map(before.flatMap((item) => (typeof idOf(item) === 'string' ? [[idOf(item), item]] : [])));
    return value.map((item) => {
        const previous = typeof idOf(item) === 'string' ? stored.get(idOf(item)) : undefined;
        return previous ? Object.assign(Object.create(null), previous, item) : item;
    });
}

const INVALID = new Error('invalid chart spec');

function invalid(): never {
    throw INVALID;
}

// A part that isn't a record reads as empty, so each of its keys reads its default; only the chart's type and its data
// are required.
function chartSpec(v: unknown): ChartSpec {
    const spec = record(v);
    const chart = record(prop(spec, 'chart'));
    const type = member(prop(chart, 'type'), CHART_TYPES);
    const data = chartData(prop(spec, 'data'));
    const defaults = defaultChartSpec(type, data);
    const axes = optionalRecord(prop(spec, 'axes'));
    const plots = optionalRecord(prop(spec, 'plots'));
    const series = optionalRecord(prop(spec, 'series'));
    const plot = (plotType: ChartType) => ({
        stacking: oneOf(
            prop(optionalRecord(own(plots, plotType)), 'stacking'),
            CHART_STACKINGS,
            defaults.plots[plotType].stacking,
        ),
    });
    return {
        chart: {
            type,
            blanks: oneOf(prop(chart, 'blanks'), CHART_BLANKS, defaults.chart.blanks),
            fontFamily: fontFamily(prop(chart, 'fontFamily'), defaults.chart.fontFamily),
        },
        title: { text: text(str(prop(optionalRecord(prop(spec, 'title')), 'text'), defaults.title.text)) },
        legend: {
            position: oneOf(
                prop(optionalRecord(prop(spec, 'legend')), 'position'),
                LEGEND_POSITIONS,
                defaults.legend.position,
            ),
        },
        axes: { x: chartAxis(own(axes, 'x'), defaults.axes.x), y: chartAxis(own(axes, 'y'), defaults.axes.y) },
        plots: { column: plot('column'), bar: plot('bar'), line: plot('line'), pie: plot('pie') },
        series: Object.fromEntries(data.series.map(({ id }) => [id, seriesStyle(own(series, id))])),
        points: chartPoints(prop(spec, 'points'), data.series),
        data,
    };
}

// An unknown kind reads its id's, so a later kind on x (a scatter's value axis) still draws as categories.
function chartAxis(v: unknown, defaults: ChartAxis): ChartAxis {
    const axis = optionalRecord(v);
    const scale = optionalRecord(prop(axis, 'scale'));
    const min = finiteOr(prop(scale, 'min'), defaults.scale.min);
    const max = finiteOr(prop(scale, 'max'), defaults.scale.max);
    const ordered = min === null || max === null || min < max;
    const format = prop(optionalRecord(prop(axis, 'labels')), 'format');
    return {
        kind: oneOf(prop(axis, 'kind'), CHART_AXIS_KINDS, defaults.kind),
        title: { text: text(str(prop(optionalRecord(prop(axis, 'title')), 'text'), defaults.title.text)) },
        visible: bool(prop(axis, 'visible'), defaults.visible),
        gridlines: {
            visible: bool(prop(optionalRecord(prop(axis, 'gridlines')), 'visible'), defaults.gridlines.visible),
        },
        labels: { format: typeof format === 'string' ? text(format) : defaults.labels.format },
        scale: {
            min: ordered ? min : null,
            max: ordered ? max : null,
            reversed: bool(prop(scale, 'reversed'), defaults.scale.reversed),
        },
    };
}

// An unknown plot type draws in the chart's. This build draws one value axis, so every series draws on y.
function seriesStyle(v: unknown): ChartSeriesStyle {
    const style = optionalRecord(v);
    const plot = prop(style, 'plot');
    const fallback = DEFAULT_CHART_SERIES_STYLE;
    return {
        plot: CHART_TYPES.find((type) => type === plot) ?? fallback.plot,
        yAxis: fallback.yAxis,
        color: color(prop(style, 'color'), fallback.color),
        line: { smooth: bool(prop(optionalRecord(prop(style, 'line')), 'smooth'), fallback.line.smooth) },
        marker: { visible: bool(prop(optionalRecord(prop(style, 'marker')), 'visible'), fallback.marker.visible) },
    };
}

// The points of the series data names, by a key that is an index; a series with none has no entry.
function chartPoints(v: unknown, series: readonly { id: string }[]): ChartSpec['points'] {
    const stored = optionalRecord(v);
    const points: ChartSpec['points'] = {};
    for (const { id } of series) {
        const entries = optionalRecord(own(stored, id));
        const read = Object.entries(entries).flatMap(([key, entry]): [number, ChartPoint][] => {
            const index = chartPointIndex(key);
            return index !== null && isRecord(entry) ? [[index, { color: color(prop(entry, 'color'), null) }]] : [];
        });
        if (read.length > 0) points[id] = Object.fromEntries(read);
    }
    return points;
}

function chartData(v: unknown): InlineChartData | RangeChartData {
    const data = record(v);
    const source = prop(data, 'source');
    const series = list(prop(data, 'series'));
    if (series.length > MAX_CHART_SERIES) invalid();
    if (source === 'inline') {
        const categories = list(prop(data, 'categories')).map(text);
        const inline = uniqueIds(series.map(inlineSeries));
        const points = inline.reduce((sum, { values }) => sum + values.length, 0);
        if (points > MAX_CHART_POINTS || categories.length > MAX_CHART_POINTS) invalid();
        return { source, categories, series: inline };
    }
    if (source === 'range') {
        const categories = prop(data, 'categories');
        return {
            source,
            categories: categories === null ? null : cellRange(categories),
            series: uniqueIds(series.map(rangeSeries)),
        };
    }
    return invalid();
}

function inlineSeries(v: unknown): InlineChartSeries {
    const series = record(v);
    return {
        id: seriesId(prop(series, 'id')),
        name: text(str(prop(series, 'name'), '')),
        values: list(prop(series, 'values')).map(finiteOrNull),
    };
}

function rangeSeries(v: unknown): RangeChartSeries {
    const series = record(v);
    const name = prop(series, 'name');
    const values = prop(series, 'values');
    return {
        id: seriesId(prop(series, 'id')),
        name: typeof name === 'string' ? text(name) : cellRange(name),
        values: values === null ? null : cellRange(values),
    };
}

function seriesId(v: unknown): string {
    return typeof v === 'string' && isChartSeriesId(v) ? v : invalid();
}

function uniqueIds<S extends { id: string }>(series: S[]): S[] {
    return new Set(series.map(({ id }) => id)).size === series.length ? series : invalid();
}

function cellRange(v: unknown): CellRangeRef {
    const ref = record(v);
    const sheetId = prop(ref, 'sheetId');
    if (typeof sheetId !== 'string' || sheetId === '') invalid();
    return {
        sheetId,
        row: span(prop(ref, 'row'), REFERENCE_ROW_COUNT),
        column: span(prop(ref, 'column'), REFERENCE_COLUMN_COUNT),
    };
}

function span(v: unknown, count: number): [number, number] {
    const bounds = list(v);
    const start = cellIndex(bounds[0], count);
    const end = cellIndex(bounds[1], count);
    return bounds.length === 2 && start <= end ? [start, end] : invalid();
}

function cellIndex(v: unknown, count: number): number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count ? v : invalid();
}

// Every chart label, stored or read from a cell, reaches SVG <text>, so what XML cannot hold is
// dropped. Truncated, not rejected: an imported file's overlong label should not cost the whole chart.
export function chartLabel(value: string): string {
    return Array.from(stripNonXmlChars(value)).slice(0, MAX_CHART_LABEL_LENGTH).join('');
}

function text(v: unknown): string {
    return typeof v === 'string' ? chartLabel(v) : invalid();
}

function finiteOrNull(v: unknown): number | null {
    if (v === null) return null;
    return typeof v === 'number' && Number.isFinite(v) ? v : invalid();
}

function finiteOr(v: unknown, fallback: number | null): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function member<T extends string>(v: unknown, allowed: readonly T[]): T {
    for (const option of allowed) {
        if (option === v) return option;
    }
    return invalid();
}

function record(v: unknown): object {
    return isRecord(v) ? v : invalid();
}

function optionalRecord(v: unknown): Record<string, unknown> {
    return isRecord(v) ? v : {};
}

function list(v: unknown): unknown[] {
    return Array.isArray(v) ? v : invalid();
}
