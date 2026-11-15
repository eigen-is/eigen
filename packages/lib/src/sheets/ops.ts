// The ops of the workbook model: six kinds of edit, such as typing into cells, a format over a range, a record made
// or changed, or rows inserted, and the cell, look and record shapes they carry. A writer builds them, the log holds
// them in batches, and every reader applies them in order to the same state. They live in lib so the sheet engine, the
// editor and the server share one vocabulary without React.

import type { ChartLook, ChartSpecPartKey } from '../types/chart';
import type { BorderSide, CellLink, ConditionalFormatRule, DataValidationRule, SingleRange } from './types';

export type Scalar = number | string | boolean;
// What an op says a cell holds. `v` with `e: 1` is an error literal, and `f` is the stored key with its `=`. `v`
// stands beside `f` only when the author gives the value, since no reader can derive it; `s` stands with neither.
export type CellContent = { v?: Scalar; e?: 1; f?: string; s?: Run[]; link?: CellLink; qp?: 1 };
export type RunStyle = { bl?: 1; it?: 1; ff?: number | string; fs?: number; fc?: string; cl?: 1; un?: 1 };
export type Run = RunStyle & { v: string };
export type CellAttrs = RunStyle & {
    fa?: string;
    ht?: number;
    vt?: number;
    tb?: string;
    bg?: string;
    rt?: number | 'vertical';
    bdt?: BorderSide;
    bdb?: BorderSide;
    bdl?: BorderSide;
    bdr?: BorderSide;
    bdd?: BorderSide;
};
export type CellAttrKey = keyof CellAttrs;
// A writer that clears a whole look names every key, since a word for "the rest" would mean another set of keys on a
// build that knows one key more.
export const LOOK_KEYS = [
    'bl',
    'it',
    'ff',
    'fs',
    'fc',
    'cl',
    'un',
    'fa',
    'ht',
    'vt',
    'tb',
    'bg',
    'rt',
    'bdt',
    'bdb',
    'bdl',
    'bdr',
    'bdd',
] as const satisfies readonly CellAttrKey[];
// The snapshot's cell and the cell of a `sheet` op: every formula carries its value here. `spill` stands only on a
// value with no `f`.
export type CellRecord = CellContent & { spill?: 1 };
export type Placed<T> = readonly [row: number, column: number, cell: T];
export type Rect = readonly [top: number, left: number, bottom: number, right: number];
export type Span = readonly [first: number, last: number];

export type SheetFields = {
    name: string;
    order: string;
    hide?: 1;
    color?: string;
    grid?: 0;
    defaultRowHeight?: number;
    defaultColWidth?: number;
    frozenRows?: number;
    frozenColumns?: number;
};
export type MergeRecord = { rect: Rect };
export type FilterRecord = { rect: Rect };
export type FilterColumnRecord = {
    filter: string;
    column: number;
    condition?: { name: string; values: string[] };
    rows: Span[];
};
export type CommentRecord = { row: number; column: number };
export type ConditionalFormatRecord = ConditionalFormatRule;
export type ValidationRecord = { ranges: SingleRange[]; order: string; rule: DataValidationRule };
type Floating = { index: string; x: number; y: number; width: number; height: number; angle?: number };
export type ImageRecord = Floating & { mediaName: string };
export type ChartRecord = Floating & Partial<ChartLook> & Record<ChartSpecPartKey, string>;
export type Records = {
    sheet: SheetFields;
    merge: MergeRecord;
    filter: FilterRecord;
    filterColumn: FilterColumnRecord;
    comment: CommentRecord;
    conditionalFormat: ConditionalFormatRecord;
    validation: ValidationRecord;
    image: ImageRecord;
    chart: ChartRecord;
};
export type RecordType = keyof Records;
export type LineAttrs = { size?: number; custom?: 1; hidden?: 1 };

// A sheet whole, as a `sheet` op adds it and the snapshot holds it. `looks` are in order of first use, walking bands
// then runs, with the plain look as index 0 and unlisted. `bands` is flat and ascending: first column, n, then n pairs
// of start row and look index.
export type SheetContent = {
    id: string;
    fields: SheetFields;
    cells: Placed<CellRecord>[];
    looks: CellAttrs[];
    bands: number[];
    rows: readonly [Span, LineAttrs][];
    columns: readonly [Span, LineAttrs][];
    records: { [T in Exclude<RecordType, 'sheet'>]?: { [id: string]: Records[T] } };
};

export type InputOp = {
    kind: 'input';
    sheet: string;
    runs?: (readonly [rect: Rect, content: CellContent | null])[];
    cells?: Placed<CellContent | null>[];
};
export type FormatOp =
    | {
          kind: 'format';
          sheet: string;
          ranges: Rect[];
          set?: CellAttrs & { link?: CellLink };
          clear?: (CellAttrKey | 'link')[];
      }
    | {
          kind: 'format';
          sheet: string;
          lines: 'rows' | 'columns';
          spans: Span[];
          set?: LineAttrs;
          clear?: (keyof LineAttrs)[];
      };
// Distributive, so that a field of one kind of conditional-format rule can be set: the rule type is a union.
type FieldsOf<R> = R extends unknown ? { [K in keyof R]?: R[K] | null } : never;
export type RecordOp = {
    [T in RecordType]: { kind: 'record'; sheet: string; type: T; id: string; set?: FieldsOf<Records[T]>; whole?: 1 };
}[RecordType];
export type LinesOp = {
    kind: 'lines';
    sheet: string;
    rows: boolean;
    insert: boolean;
    index: number;
    count: number;
    like?: number;
};
export type MoveOp = { kind: 'move'; sheet: string; from: Rect; toSheet: string; toRow: number; toColumn: number };
export type SheetOp = { kind: 'sheet'; add: SheetContent } | { kind: 'sheet'; delete: string };
export type Op = InputOp | FormatOp | RecordOp | LinesOp | MoveOp | SheetOp;
export type OpKind = Op['kind'];
export type Batch = { g: number; ops: Op[] };
export type OpReferences = { media: string[]; comments: string[] };

// The media files and comment cards an op brings in, so a sweep keeps them: media an image record is set to, a card
// when it is made. A field edit of a card that is already there, or an op that takes one away, names nothing.
export function opReferences(op: Op): OpReferences {
    const names: OpReferences = { media: [], comments: [] };
    switch (op.kind) {
        case 'input':
        case 'format':
        case 'lines':
        case 'move':
            return names;
        case 'record':
            if (op.type === 'image' && typeof op.set?.mediaName === 'string') names.media.push(op.set.mediaName);
            if (op.type === 'comment' && op.set && op.whole) names.comments.push(op.id);
            return names;
        case 'sheet':
            if ('add' in op) {
                for (const image of Object.values(op.add.records.image ?? {})) names.media.push(image.mediaName);
                names.comments.push(...Object.keys(op.add.records.comment ?? {}));
            }
            return names;
    }
}

// Whether an op renumbers places or sheets, so that nothing commutes with it.
export function isStructural(op: Op): boolean {
    switch (op.kind) {
        case 'lines':
        case 'move':
        case 'sheet':
            return true;
        case 'input':
        case 'format':
        case 'record':
            return false;
    }
}
