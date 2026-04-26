import {describe, expect, it} from "bun:test";
import {Context} from "../../index";
import {handleCut} from "../modules/clipboard";
import {contextFactory} from "./factories/context";

// setPendingCopy uses document.createElement to extract plain text from HTML
(globalThis as any).document = {
    createElement: () => ({innerHTML: "", innerText: "", textContent: ""}),
};

// sessionStorage is not available in Bun's test environment
(globalThis as any).sessionStorage = {setItem: () => {}};

describe("handleCut", () => {
    it("flips luckysheet_paste_iscut to true", () => {
        const ctx = contextFactory() as Context;
        ctx.luckysheet_paste_iscut = false;
        handleCut(ctx);
        expect(ctx.luckysheet_paste_iscut).toBe(true);
    });
});
