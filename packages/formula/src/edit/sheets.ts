// The rewrites of the sheet a reference names. A reference holds a sheet id, so a rename or a deleted sheet
// rewrites nothing; text changes only where a sheet gets a new id, as an imported or duplicated tab does, and where
// a formula typed with a name meets a sheet of that name: as it enters a workbook, which the shape table asks for,
// or when a sheet appears under the name later, which the plan of that edit asks for.

import { REF_ERROR } from '../text/lexer';
import { findSheetByName } from '../text/sheet-name';
import type { FormulaNode } from '../text/tree';
import { leaf, NodeKind, referenceNode, SheetKind } from '../text/tree';
import { mapLeaves } from './leaves';

export type NamedSheet = { readonly id: string; readonly name: string };

// Every sheet id that is a key of `ids` becomes its value.
export function remapSheets(tree: FormulaNode, ids: ReadonlyMap<string, string>): FormulaNode {
    return mapLeaves(tree, (node) => {
        if (node.sheetKind !== SheetKind.Id) return node;
        const id = ids.get(node.sheet);
        return id === undefined ? node : onSheet(node, id);
    });
}

// Binds what was typed with the name of a sheet that did not exist to the sheet that now has that name.
export function bindSheet(tree: FormulaNode, name: string, id: string): FormulaNode {
    return bindSheets(tree, [{ id, name }]);
}

// Binds what was typed with the name of one of `sheets` to that sheet.
export function bindSheets(tree: FormulaNode, sheets: readonly NamedSheet[]): FormulaNode {
    return mapLeaves(tree, (node) => {
        const named = node.sheetKind === SheetKind.Name ? findSheetByName(sheets, node.sheet) : undefined;
        return named === undefined ? node : onSheet(node, named.id);
    });
}

// Puts #REF! where a formula was typed with the name of one of `sheets`: for a formula too long to store bound.
export function breakSheets(tree: FormulaNode, sheets: readonly NamedSheet[]): FormulaNode {
    return mapLeaves(tree, (node) => {
        const named = node.sheetKind === SheetKind.Name && findSheetByName(sheets, node.sheet) !== undefined;
        return named ? leaf(NodeKind.Error, REF_ERROR, '', node.space, SheetKind.Host, '') : node;
    });
}

function onSheet(node: FormulaNode, id: string): FormulaNode {
    if (node.kind !== NodeKind.Ref) return leaf(node.kind, node.value, node.text, node.space, SheetKind.Id, id);
    const { row, column, row2, column2 } = node;
    return referenceNode(node.op, node.space, SheetKind.Id, id, row, column, row2, column2, node.flags);
}
