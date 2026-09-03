import { describe, expect, test } from 'bun:test';
import { serializeFill, solidFill } from '../../../vector/fill';
import { ELEMENT_KINDS } from '../../../vector/kinds';
import type { VectorRichTextElement } from '../../../vector/types';
import { richtext } from '../element-factories';

function styleOf(el: VectorRichTextElement): string {
    const out = ELEMENT_KINDS.richtext.render(el, {});
    if ('svg' in out) throw new Error('rich text must render html');
    return out.style;
}

describe('rich text box paint', () => {
    test('a transparent fill paints no background', () => {
        expect(styleOf(richtext({ id: 'rt1' }))).not.toContain('background');
    });

    test('a solid fill paints a background colour', () => {
        expect(styleOf(richtext({ id: 'rt1', fill: solidFill('#ffcc00') }))).toContain('background-color:#ffcc00');
    });

    test('a gradient fill paints a CSS linear-gradient', () => {
        const fill = serializeFill({ type: 'gradient', from: '#000000', to: '#ffffff', angle: 45, style: 'solid' });
        expect(styleOf(richtext({ id: 'rt1', fill }))).toContain(
            'background-image:linear-gradient(45deg, #000000, #ffffff)',
        );
    });

    test('stroke fields are the border, and a border makes the box border-box', () => {
        const style = styleOf(richtext({ id: 'rt1', strokeColor: '#1e1e1e', strokeWidth: 2, strokeStyle: 'dashed' }));
        expect(style).toContain('border:2px dashed #1e1e1e');
        expect(style).toContain('box-sizing:border-box');
    });

    test('a transparent stroke colour or zero width paints no border', () => {
        expect(styleOf(richtext({ id: 'rt1', strokeColor: 'transparent' }))).not.toContain('border:');
        expect(styleOf(richtext({ id: 'rt1', strokeColor: '#111', strokeWidth: 0 }))).not.toContain('border:');
    });

    test('corners become border-radius; straight corners emit none', () => {
        expect(styleOf(richtext({ id: 'rt1', corners: 'round', width: 200, height: 80 }))).toContain(
            'border-radius:40px',
        );
        expect(styleOf(richtext({ id: 'rt1', corners: 'straight' }))).not.toContain('border-radius');
    });

    test('box-sizing is emitted once when both padding and a border are present', () => {
        const style = styleOf(richtext({ id: 'rt1', padding: 12, strokeColor: '#111', strokeWidth: 1 }));
        expect(style.match(/box-sizing:border-box/g)?.length).toBe(1);
    });

    test('the box still spills its text and keeps its typography', () => {
        const style = styleOf(richtext({ id: 'rt1', fill: solidFill('#ffcc00'), strokeColor: '#111' }));
        expect(style).toContain('overflow:visible');
        expect(style).toContain('font-size:20px');
    });
});
