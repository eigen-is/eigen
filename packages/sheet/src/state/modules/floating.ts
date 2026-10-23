import { floatingItems, nextFloatingIndex, type SheetFloatingKind, sheetFloatingBox } from '@workspace/lib/sheets';
import { type Box, DUPLICATE_OFFSET, type ZOp, zOrderKeys } from '@workspace/lib/vector';
import type { Patch } from 'immer';
import { v4 as uuidv4 } from 'uuid';
import type { Context } from '../context';
import { getSheetIndex } from '../utils';

// What images and charts share. Each writer touches one object of the current sheet and nothing else, field by field,
// so a batch on an object a peer deleted fails whole on every client and in the replay. What writes a whole object
// brings one a peer deleted back on every client, last writer wins: redoing its insert, undoing its delete, and
// undoing or redoing a row or column op that shifted a chart.

export type FloatingRef = { kind: SheetFloatingKind; id: string };

const FIELD = { image: 'images', chart: 'charts' } as const;

// The current sheet, when this client may write to it.
export function editableCurrentSheet(ctx: Context) {
    if (ctx.allowEdit === false) return undefined;
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    return index == null ? undefined : ctx.sheets[index];
}

// Writes only the fields given, each clamped as the whole box is; a first rotate adds `angle`.
export function updateFloatingBox(ctx: Context, { kind, id }: FloatingRef, fields: Partial<Box>) {
    const object = editableCurrentSheet(ctx)?.[FIELD[kind]]?.[id];
    if (!object) return;
    const clamped = sheetFloatingBox({ ...object, ...fields });
    for (const field of ['x', 'y', 'width', 'height', 'angle'] as const) {
        if (field in fields) object[field] = clamped[field];
    }
}

// One z-order move over images and charts together, writing the moved object's index and any tied key it repairs.
export function reorderFloatingObject(ctx: Context, { kind, id }: FloatingRef, op: ZOp) {
    const sheet = editableCurrentSheet(ctx);
    if (!sheet?.[FIELD[kind]]?.[id]) return;
    const objects = floatingItems(sheet).map(({ object }) => object);
    for (const { id: moved, index } of zOrderKeys(objects, [id], op)) {
        const object = objects.find((o) => o.id === moved);
        if (object) object.index = index;
    }
}

// A copy one step down and right of the original, above every object, selected, as Vector's Duplicate.
export function duplicateFloatingObject(ctx: Context, { kind, id }: FloatingRef) {
    const sheet = editableCurrentSheet(ctx);
    const original = sheet?.[FIELD[kind]]?.[id];
    if (!sheet || !original) return;
    const copy = uuidv4();
    const placed = {
        id: copy,
        index: nextFloatingIndex(sheet),
        ...sheetFloatingBox({ ...original, x: original.x + DUPLICATE_OFFSET, y: original.y + DUPLICATE_OFFSET }),
    };
    if (kind === 'image' && sheet.images?.[id]) sheet.images[copy] = { ...sheet.images[id], ...placed };
    if (kind === 'chart' && sheet.charts?.[id]) sheet.charts[copy] = { ...sheet.charts[id], ...placed };
    ctx.activeObject = { kind, id: copy, editor: false };
}

export function deleteFloatingObject(ctx: Context, { kind, id }: FloatingRef) {
    const objects = editableCurrentSheet(ctx)?.[FIELD[kind]];
    if (objects?.[id]) delete objects[id];
}

// Selecting a chart keeps its editor open when another chart's was.
export function selectFloatingObject(ctx: Context, ref: FloatingRef, editor = false) {
    ctx.activeObject = { ...ref, editor: ref.kind === 'chart' && (editor || ctx.activeObject?.editor === true) };
}

export function deselectFloatingObject(ctx: Context) {
    ctx.activeObject = undefined;
}

export function deleteActiveObject(ctx: Context) {
    if (!ctx.activeObject) return;
    deleteFloatingObject(ctx, ctx.activeObject);
    ctx.activeObject = undefined;
}

// A field patch on an object a peer deleted cannot resolve, and immer throws on it; the object's own add and remove
// (a path ending at its id) still apply.
export function editsDeletedFloatingObject(ctx: Context, patches: Patch[]): boolean {
    return patches.some(({ path: [root, sheet, field, id, ...rest] }) => {
        if (root !== 'sheets' || typeof sheet !== 'number' || rest.length === 0) return false;
        if (field !== 'images' && field !== 'charts') return false;
        return ctx.sheets[sheet]?.[field]?.[id] == null;
    });
}
