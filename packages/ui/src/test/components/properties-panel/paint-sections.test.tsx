import { afterEach, describe, expect, mock, test } from 'bun:test';
import { MAX_SKETCH_POINTS } from '@workspace/lib/charts';
import type { Fill } from '@workspace/lib/types/background';
import { parseFill, serializeFill, TRANSPARENT_FILL } from '@workspace/lib/vector';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { PaintSections } = await import('../../../components/properties-panel');

type Props = Parameters<typeof PaintSections>[0];

let unmount = async () => {};
afterEach(() => unmount());

const CHART: Omit<Props, 'onFill' | 'onChange'> = {
    fill: serializeFill(TRANSPARENT_FILL),
    fillStyle: 'solid',
    marksHatch: true,
    strokeColor: '#757575',
    strokeWidth: 2,
    strokeStyle: 'solid',
    strokeOptional: true,
    roughness: 0,
    color: '#202124',
};

async function mount(props: Partial<Props> = {}) {
    const onFill = mock((_next: (fill: Fill) => Fill) => {});
    const onChange = mock((_patch: Record<string, unknown>) => {});
    const rendered = await renderInDocument(createElement(PaintSections, { ...CHART, onFill, onChange, ...props }));
    unmount = rendered.unmount;
    const sections = [...rendered.container.querySelectorAll('h4')].map((h) => h.textContent);
    return { container: rendered.container, sections, onFill, onChange };
}

// A section's row control, beside its label span.
function row(container: HTMLElement, section: string, label: string): HTMLElement {
    const heading = [...container.querySelectorAll('h4')].find((h) => h.textContent === section);
    const scope = heading?.parentElement;
    const span = [...(scope?.querySelectorAll('span.w-14') ?? [])].find((s) => s.textContent?.trim() === label);
    const control = span?.nextElementSibling;
    if (!(control instanceof HTMLElement)) throw new Error(`no ${section} › ${label} row`);
    return control;
}

const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

async function type(container: HTMLElement, section: string, label: string, value: string) {
    const input = row(container, section, label).querySelector('input');
    if (!input) throw new Error(`no field under ${section} › ${label}`);
    await act(async () => {
        input.focus();
        setValue?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function choose(container: HTMLElement, section: string, label: string, option: string) {
    const trigger = row(container, section, label).querySelector('[data-slot="select-trigger"]');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const list = [...document.querySelectorAll('[data-slot="select-content"]')].at(-1);
    const item = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
        (el) => el.textContent?.trim() === option,
    );
    if (!item) throw new Error(`no "${option}" under ${section} › ${label}`);
    await act(async () => {
        item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

describe('PaintSections', () => {
    test("a chart's look: label color, fill and its hatch, stroke and sketch", async () => {
        const { container, sections } = await mount();
        expect(sections).toEqual(['Labels', 'Fill', 'Stroke', 'Sketch']);
        for (const [section, label] of [
            ['Labels', 'Color'],
            ['Fill', 'Style'],
            ['Stroke', 'Color'],
            ['Stroke', 'Width'],
            ['Stroke', 'Style'],
            ['Sketch', 'Style'],
        ])
            expect(row(container, section, label)).toBeInstanceOf(HTMLElement);
    });

    // A shape's hatch fills its body, so with no paint there is nothing to hatch; a chart's hatch is its bars'.
    test('the hatch row shows without a paint only where the marks hatch', async () => {
        const shape = await mount({ marksHatch: false, color: undefined });
        expect(shape.sections).toEqual(['Fill', 'Stroke', 'Sketch']);
        expect(() => row(shape.container, 'Fill', 'Style')).toThrow();
    });

    test('rows a host leaves out are absent', async () => {
        const { container, sections } = await mount({ fill: undefined, strokeStyle: undefined, color: undefined });
        expect(sections).toEqual(['Stroke', 'Sketch']);
        expect(() => row(container, 'Stroke', 'Style')).toThrow();
    });

    test('each row writes its own field', async () => {
        const { container, onChange, onFill } = await mount();
        await choose(container, 'Sketch', 'Style', 'Cartoonist');
        await type(container, 'Stroke', 'Width', '1.5');
        await choose(container, 'Stroke', 'Style', 'Dashed');
        expect(onChange.mock.calls.map(([patch]) => patch)).toEqual([
            { roughness: 2 },
            { strokeWidth: 1.5 },
            { strokeStyle: 'dashed' },
        ]);
        await choose(container, 'Fill', 'Style', 'Cross-hatch');
        const [[next]] = onFill.mock.calls;
        expect(next(parseFill(CHART.fill as string))).toEqual({ ...TRANSPARENT_FILL, style: 'cross-hatch' });
    });

    // A pptx's 1 pt line on a 10 in deck.
    test('the stroke width shows to the hundredth', async () => {
        const { container } = await mount({ strokeWidth: 2.6666666666666665 });
        expect(row(container, 'Stroke', 'Width').querySelector('input')?.value).toBe('2.67');
    });

    test('says when the data draws flat', async () => {
        const capped = await mount({ sketchCapped: true });
        expect(capped.container.textContent).toContain(`${MAX_SKETCH_POINTS} points`);
        await unmount();
        const small = await mount();
        expect(small.container.textContent).not.toContain(`${MAX_SKETCH_POINTS} points`);
    });
});
