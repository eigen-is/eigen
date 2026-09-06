import { describe, expect, test } from 'bun:test';
import { serializeFill, solidFill } from '../../../vector/fill';
import { ELEMENT_KINDS, richTextCssText } from '../../../vector/kinds';
import type { VectorRichTextElement } from '../../../vector/types';
import { richtext } from '../element-factories';

function renderOf(el: VectorRichTextElement): { style: string; svg: string } {
    const out = ELEMENT_KINDS.richtext.render(el, {});
    if (!('html' in out)) throw new Error('rich text must render html');
    return out;
}

function styleOf(el: VectorRichTextElement): string {
    return renderOf(el).style;
}

// The roughjs drawable painted behind the text — the box's own fill and border.
function backdropOf(el: VectorRichTextElement): string {
    return renderOf(el).svg;
}

describe('rich text box paint', () => {
    test('a solid fill is the roughjs fill every shape paints, not a CSS background', () => {
        const el = richtext({ id: 'rt1', fill: solidFill('#ffcc00') });
        expect(backdropOf(el)).toContain('#ffcc00');
        expect(styleOf(el)).not.toContain('background-color');
    });

    test('a gradient fill rides the per-element defs every other kind emits', () => {
        const fill = serializeFill({ type: 'gradient', from: '#000000', to: '#ffffff', angle: 45, style: 'solid' });
        const el = richtext({ id: 'rt1', fill });
        expect(backdropOf(el)).toContain('<defs><linearGradient id="fill-rt1"');
        expect(styleOf(el)).not.toContain('background-image');
    });

    test('a hatch style hatches, which is the capability the box gained', () => {
        const paths = backdropOf(richtext({ id: 'rt1', fill: solidFill('#ffcc00', 'cross-hatch') })).match(/<path/g);
        expect(paths?.length).toBeGreaterThan(1);
    });

    test('stroke fields are the border, drawn as the shapes drawable rather than CSS', () => {
        const el = richtext({ id: 'rt1', strokeColor: '#1e1e1e', strokeWidth: 2, strokeStyle: 'dashed' });
        expect(backdropOf(el)).toContain('<g stroke-linecap="round">');
        expect(styleOf(el)).not.toContain('border:');
    });

    test('corners shape the drawn box, never a CSS border-radius', () => {
        const straight = richtext({ id: 'rt1', corners: 'straight', width: 200, height: 80 });
        const round = richtext({ id: 'rt1', corners: 'round', width: 200, height: 80 });
        expect(backdropOf(round)).not.toBe(backdropOf(straight));
        expect(styleOf(round)).not.toContain('border-radius');
    });

    test('a box with neither fill nor border carries no backdrop at all', () => {
        expect(backdropOf(richtext({ id: 'rt1', strokeColor: 'transparent' }))).toBe('');
        expect(backdropOf(richtext({ id: 'rt1', strokeColor: '#111', strokeWidth: 0 }))).toBe('');
    });

    test('the inset absorbs the border width, and border-box rides along once', () => {
        const style = styleOf(richtext({ id: 'rt1', padding: 8, strokeColor: '#111', strokeWidth: 2 }));
        expect(style).toContain('padding:10px');
        expect(style.match(/box-sizing:border-box/g)?.length).toBe(1);
    });

    test('richTextCssText is exactly the style the renderer emits', () => {
        const el = richtext({ id: 'rt1', fill: solidFill('#ffcc00'), padding: 8 });
        expect(styleOf(el)).toBe(richTextCssText(el));
    });

    test('the box still spills its text and keeps its typography', () => {
        const style = styleOf(richtext({ id: 'rt1', fill: solidFill('#ffcc00'), strokeColor: '#111' }));
        expect(style).toContain('overflow:visible');
        expect(style).toContain('font-size:20px');
    });
});
