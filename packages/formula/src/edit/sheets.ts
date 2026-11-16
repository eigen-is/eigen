// The rewrites of the sheet a reference names. A reference holds a sheet id, so a rename or a deleted sheet
// rewrites nothing; text changes only where a sheet gets a new id, as an imported or duplicated tab does, and where
// a formula typed with a name meets a sheet of that name: as it enters a workbook, which the shape table asks for,
// or when a sheet appears under the name later, which the plan of that edit asks for.

import { REF_ERROR } from '../text/lexer';
import { sheetNameKey } from '../text/sheet-name';
import type { FormulaNode } from '../text/tree';
import { leaf, NodeKind, referenceNode, SheetKind } from '../text/tree';
import { mapLeaves } from './leaves';

// The id of the sheet a name typed in a formula reads, or undefined where no sheet has the name.
export type SheetNamed = (name: string) => string | undefined;

// Binds what was typed with the name of a sheet that did not exist to the sheet that now has that name.
export function bindSheet(tree: FormulaNode, name: string, id: string): FormulaNode {
    const key = sheetNameKey(name);
    return bindSheets(tree, (typed) => (sheetNameKey(typed) === key ? id : undefined));
}

// Binds what was typed with the name of a sheet `named` finds to that sheet.
export function bindSheets(tree: FormulaNode, named: SheetNamed): FormulaNode {
    return mapLeaves(tree, (node) => {
        const id = node.sheetKind === SheetKind.Name ? named(node.sheet) : undefined;
        return id === undefined ? node : onSheet(node, id);
    });
}

// Puts #REF! where a formula was typed with the name of a sheet `named` finds: for a formula too long to store
// bound.
export function breakSheets(tree: FormulaNode, named: SheetNamed): FormulaNode {
    return mapLeaves(tree, (node) => {
        const held = node.sheetKind === SheetKind.Name && named(node.sheet) !== undefined;
        return held ? leaf(NodeKind.Error, REF_ERROR, '', node.space, SheetKind.Host, '') : node;
    });
}

function onSheet(node: FormulaNode, id: string): FormulaNode {
    if (node.kind !== NodeKind.Ref) return leaf(node.kind, node.value, node.text, node.space, SheetKind.Id, id);
    const { row, column, row2, column2 } = node;
    return referenceNode(node.op, node.space, SheetKind.Id, id, row, column, row2, column2, node.flags);
}
