import {describe, expect, it} from "bun:test";
import type {Context} from "../../index";
import {applyColorScalePreset, applyDataBarPreset, clearSheetRules, CF_PRESETS} from "../modules/conditionFormat";
import {contextFactory} from "./factories/context";

describe("CF_PRESETS", () => {
    it("defines 12 colorGradation presets", () => {
        for (let i = 1; i <= 12; i++) {
            expect(CF_PRESETS[`colorGradation_${i}`]).toBeDefined();
        }
    });

    it("defines 6 solidColorDataBar presets", () => {
        for (let i = 1; i <= 6; i++) {
            expect(CF_PRESETS[`solidColorDataBar_${i}`]).toHaveLength(1);
        }
    });
});

describe("applyColorScalePreset", () => {
    it("appends a colorGradation rule with the preset's format array", () => {
        const ctx = contextFactory() as Context;
        applyColorScalePreset(ctx, "colorGradation_1");
        const rules = ctx.luckysheetfile[0].luckysheet_conditionformat_save!;
        expect(rules).toHaveLength(1);
        expect(rules[0].type).toBe("colorGradation");
        expect(rules[0].format).toEqual(CF_PRESETS.colorGradation_1);
    });

    it("ignores unknown preset keys", () => {
        const ctx = contextFactory() as Context;
        applyColorScalePreset(ctx, "nonsense_key");
        expect(ctx.luckysheetfile[0].luckysheet_conditionformat_save ?? []).toHaveLength(0);
    });
});

describe("applyDataBarPreset", () => {
    it("appends a dataBar rule with the preset's format array", () => {
        const ctx = contextFactory() as Context;
        applyDataBarPreset(ctx, "solidColorDataBar_1");
        const rules = ctx.luckysheetfile[0].luckysheet_conditionformat_save!;
        expect(rules).toHaveLength(1);
        expect(rules[0].type).toBe("dataBar");
        expect(rules[0].format).toEqual(CF_PRESETS.solidColorDataBar_1);
    });

    it("ignores unknown preset keys", () => {
        const ctx = contextFactory() as Context;
        applyDataBarPreset(ctx, "nonsense_key");
        expect(ctx.luckysheetfile[0].luckysheet_conditionformat_save ?? []).toHaveLength(0);
    });
});

describe("clearSheetRules", () => {
    it("empties the sheet's conditional-format rules array", () => {
        const ctx = contextFactory() as Context;
        applyColorScalePreset(ctx, "colorGradation_1");
        clearSheetRules(ctx);
        expect(ctx.luckysheetfile[0].luckysheet_conditionformat_save).toHaveLength(0);
    });
});
