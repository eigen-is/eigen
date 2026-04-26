import {describe, expect, it} from "bun:test";
import type {Context} from "../../index";
import {handleCut} from "../modules/clipboard";
import {contextFactory} from "./factories/context";

// setPendingCopy uses document.createElement to extract plain text from HTML
(globalThis as any).document = {
    createElement: () => ({innerHTML: "", innerText: "", textContent: ""}),
};

// sessionStorage is not available in Bun's test environment
(globalThis as any).sessionStorage = {setItem: () => {}};

describe("handleCut", () => {
    it("marks the copy range as cut and populates copy data", () => {
        const ctx = contextFactory({
            luckysheetfile: [
                {
                    name: "sheet",
                    id: "id_1",
                    data: [
                        [null, {m: "A", v: "A"}, null, null],
                        [null, null, null, null],
                        [null, null, null, null],
                        [null, null, null, null],
                    ],
                    order: 0,
                },
            ],
        }) as Context;
        ctx.luckysheet_paste_iscut = false;

        handleCut(ctx);

        expect(ctx.luckysheet_paste_iscut).toBe(true);
        expect(ctx.luckysheet_selection_range).toHaveLength(1);
        expect(ctx.luckysheet_copy_save?.dataSheetId).toBe("id_1");
    });

    it("does not set the cut flag when selection is empty", () => {
        const ctx = contextFactory({
            luckysheet_select_save: [],
        }) as Context;
        ctx.luckysheet_paste_iscut = false;

        handleCut(ctx);

        expect(ctx.luckysheet_paste_iscut).toBe(false);
    });
});
