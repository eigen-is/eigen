import {describe, expect, test} from "bun:test";
import type {Patch} from "immer";
import {opToPatchOnSheets} from "@workspace/lib/sheets/yjs-ops";
import type {Op, Sheet} from "../types";
import type {Context} from "../context";
import {opToPatch} from "./patch";

const SHEETS: Sheet[] = [
    {id: "sheet-1", name: "Sheet1", order: 0, celldata: [], config: {}},
    {id: "sheet-2", name: "Sheet2", order: 1, celldata: [], config: {}},
];

const ctx = {
    luckysheetfile: SHEETS,
    currentSheetId: "sheet-1",
} as Context;

describe("opToPatch parity with opToPatchOnSheets", () => {
    test("cell-edit op: wrapper rebases path with luckysheetfile prefix", () => {
        const ops: Op[] = [{op: "replace", id: "sheet-2", path: ["celldata", 0, "v"], value: 7}];
        const [pure] = opToPatchOnSheets(ctx.luckysheetfile, ops);
        const [wrapped] = opToPatch(ctx, ops);
        expect(wrapped).toEqual(pure.map((p) => ({...p, path: ["luckysheetfile", ...p.path]})));
    });

    test("orphan op: both pure and wrapper drop it", () => {
        const ops: Op[] = [{op: "replace", id: "sheet-missing", path: ["celldata"], value: 1}];
        const [pure] = opToPatchOnSheets(ctx.luckysheetfile, ops);
        const [wrapped] = opToPatch(ctx, ops);
        expect(pure).toEqual([]);
        expect(wrapped).toEqual([]);
    });

    test("images op on currentSheetId: wrapper adds insertedImgs side patch", () => {
        const ops: Op[] = [{op: "add", id: "sheet-1", path: ["images", 0], value: {id: "img-1"}}];
        const [pure] = opToPatchOnSheets(ctx.luckysheetfile, ops);
        const [wrapped] = opToPatch(ctx, ops);
        const expected: Patch[] = [
            ...pure.map((p) => ({...p, path: ["luckysheetfile", ...p.path]})),
            {op: "add", value: {id: "img-1"}, path: ["insertedImgs"]},
        ];
        expect(wrapped).toEqual(expected);
    });
});
