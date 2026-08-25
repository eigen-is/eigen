import { describe, expect, it } from 'bun:test';
import type { Context } from '../../index';
import {
    applyColorScalePreset,
    applyDataBarPreset,
    CF_PRESETS,
    clearSheetRules,
} from '../../state/modules/condition-format';
import { contextFactory } from './factories/context';

describe('CF_PRESETS', () => {
    it('defines 12 colorGradation presets', () => {
        for (let i = 1; i <= 12; i++) {
            expect(CF_PRESETS[`colorGradation_${i}`]).toBeDefined();
        }
    });

    it('defines 6 solidColorDataBar presets', () => {
        for (let i = 1; i <= 6; i++) {
            expect(CF_PRESETS[`solidColorDataBar_${i}`]).toHaveLength(1);
        }
    });
});

describe('applyColorScalePreset', () => {
    it("appends a colorGradation rule with the preset's format array", () => {
        const ctx = contextFactory() as Context;
        applyColorScalePreset(ctx, 'colorGradation_1');
        const rules = ctx.sheets[0].conditionalFormatRules!;
        expect(rules).toHaveLength(1);
        const rule = rules[0];
        if (rule.type !== 'colorGradation') throw new Error(`expected colorGradation, got ${rule.type}`);
        expect(rule.format).toEqual(CF_PRESETS.colorGradation_1);
    });

    it('ignores unknown preset keys', () => {
        const ctx = contextFactory() as Context;
        applyColorScalePreset(ctx, 'nonsense_key');
        expect(ctx.sheets[0].conditionalFormatRules ?? []).toHaveLength(0);
    });
});

describe('applyDataBarPreset', () => {
    it("appends a dataBar rule with the preset's format array", () => {
        const ctx = contextFactory() as Context;
        applyDataBarPreset(ctx, 'solidColorDataBar_1');
        const rules = ctx.sheets[0].conditionalFormatRules!;
        expect(rules).toHaveLength(1);
        const rule = rules[0];
        if (rule.type !== 'dataBar') throw new Error(`expected dataBar, got ${rule.type}`);
        expect(rule.format).toEqual(CF_PRESETS.solidColorDataBar_1);
    });

    it('ignores unknown preset keys', () => {
        const ctx = contextFactory() as Context;
        applyDataBarPreset(ctx, 'nonsense_key');
        expect(ctx.sheets[0].conditionalFormatRules ?? []).toHaveLength(0);
    });
});

describe('clearSheetRules', () => {
    it("empties the sheet's conditional-format rules array", () => {
        const ctx = contextFactory() as Context;
        applyColorScalePreset(ctx, 'colorGradation_1');
        clearSheetRules(ctx);
        expect(ctx.sheets[0].conditionalFormatRules).toHaveLength(0);
    });
});
