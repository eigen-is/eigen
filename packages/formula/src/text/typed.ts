// The two crossings between what a person types at a cell and what the cell stores. storedText gives the text to
// store for a typed formula, and typedText gives the formula bar's text back for a shape at a cell. They are a pair
// because text that does not parse is kept: it is stored behind a mark that no grammar reads as a formula, and
// shows again exactly as it was typed.

import type { SheetFinder } from './parser';
import { isUnparsed, parseA1 } from './parser';
import type { SheetNames } from './printer';
import { printA1, storedKey } from './printer';
import type { Shape } from './shapes';

// `typed` starts with its =, so text that does not parse is stored behind two. So is a formula whose stored text
// would be too long to read back.
export function storedText(typed: string, hostRow: number, hostColumn: number, findSheet: SheetFinder): string {
    const tree = parseA1(typed, hostRow, hostColumn, findSheet);
    const key = 'reason' in tree ? tree : storedKey(tree);
    return typeof key === 'string' ? key : `=${typed}`;
}

export function typedText(shape: Shape, hostRow: number, hostColumn: number, sheetName: SheetNames): string {
    if (shape.tree) return printA1(shape.tree, hostRow, hostColumn, sheetName);
    return isUnparsed(shape.text) ? shape.text.slice(1) : shape.text;
}
