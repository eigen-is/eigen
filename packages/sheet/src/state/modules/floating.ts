import {
    editsMissingFloatingObject,
    floatingItems,
    nextFloatingIndex,
    type SheetFloatingKind,
    sheetFloatingBox,
} from '@workspace/lib/sheets';
import { type Box, DUPLICATE_OFFSET, type ZOp, zOrderKeys } from '@workspace/lib/vector';
import type { Patch } from 'immer';
import { v4 as uuidv4 } from 'uuid';
import type { Context } from '../context';
import { getSheetIndex } from '../utils';

// What images and charts share. Each writer touches one object of the current sheet and nothing else, field by field,
// so a write on an object a peer deleted is dropped on every client and in the replay. What writes a whole object,
// redoing its insert or undoing its delete, brings one a peer deleted back only where the delete arrived first.

export type FloatingRef = { kind: SheetFloatingKind; id: string };

const FIELD = { image: 'images', chart: 'charts' } as const;

// The fields of a box a gesture writes, each only when it changed.
export const FLOATING_BOX_FIELDS = ['x', 'y', 'width', 'height', 'angle'] as const;

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
    for (const field of FLOATING_BOX_FIELDS) {
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
    ctx.activeObject = { kind, id: copy };
}

export function deleteFloatingObject(ctx: Context, { kind, id }: FloatingRef) {
    const objects = editableCurrentSheet(ctx)?.[FIELD[kind]];
    if (objects?.[id]) delete objects[id];
}

export function selectFloatingObject(ctx: Context, ref: FloatingRef) {
    ctx.activeObject = ref;
}

export function deselectFloatingObject(ctx: Context) {
    ctx.activeObject = undefined;
}

export function deleteActiveObject(ctx: Context) {
    if (!ctx.activeObject) return;
    deleteFloatingObject(ctx, ctx.activeObject);
    ctx.activeObject = undefined;
}

// What of an undo or redo entry still applies: a write into an image or chart a peer deleted is dropped, as every
// client and the replay drop it from a batch. One the entry itself writes back first stays, as a merged gesture's
// undo of an edit and a delete puts the object back and then its field.
export function withoutDeletedFloatingEdits(ctx: Context, patches: Patch[]): Patch[] {
    const written = new Map<string, boolean>();
    return patches.filter(({ op, path: [root, ...path] }) => {
        if (root !== 'sheets') return true;
        const key = path.slice(0, 3).join('/');
        if (path.length === 3) written.set(key, op !== 'remove');
        return written.get(key) === true || !editsMissingFloatingObject(ctx.sheets, path);
    });
}
