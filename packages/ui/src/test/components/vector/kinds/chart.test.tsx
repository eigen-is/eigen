import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { DEFAULT_CHART_SERIES_STYLE, newChartSpecParts, readChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { ChartType } from '@workspace/lib/types/chart';
import type { StyleDefaults, VectorChartElement, VectorElement } from '@workspace/lib/vector';
import {
    DEFAULT_ELEMENT_PROPS,
    prop,
    readVectorFromDoc,
    SLIDES_STYLE_DEFAULTS,
    VECTOR_STYLE_DEFAULTS,
    writeElementInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useRef, useState } = await import('react');
const realCollab = await import('@workspace/lib/collab');
type UseCollabDocOptions = Parameters<typeof realCollab.useCollabDoc>[0];

// Each peer's canvas reads its own doc, by mount, with the canvas's own undo scope and no server behind it.
const peerDocs = new Map<string, Y.Doc>();
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: (options: UseCollabDocOptions) => {
        const doc = peerDocs.get(options.mountId) ?? new Y.Doc();
        const docRef = useRef(doc);
        const [provider] = useState(() => new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false }));
        const [undoManager] = useState(() => {
            const scope = options.undoScope?.(doc);
            return scope ? new Y.UndoManager(scope) : null;
        });
        const onInit = useRef(options.onInit);
        useEffect(() => {
            const cleanup = onInit.current?.({ doc, provider, undoManager });
            return () => {
                cleanup?.();
                provider.destroy();
            };
        }, []);
        return {
            doc,
            docRef,
            provider,
            undoManager,
            synced: true,
            offline: false,
            loaded: true,
            storageUnavailable: false,
            storageGone: false,
            unsyncedEdits: false,
        };
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
});

const { createRoot } = await import('react-dom/client');
const { holdCapture, PropertyGestureContext, sealed } = await import('../../../../components/properties-panel');
const { ChartEditDialog, ChartPanelSection, newChartElement } = await import(
    '../../../../components/vector/kinds/chart'
);
const { CanvasPropertiesPanel, useCanvasDoc } = await import('../../../../components/vector');

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

function chart(id: string, type: ChartType = 'column'): VectorChartElement {
    return {
        ...DEFAULT_ELEMENT_PROPS,
        id,
        type: 'chart',
        x: 0,
        y: 0,
        width: 640,
        height: 400,
        angle: 0,
        index: 'a0',
        ...newChartSpecParts(sampleChartSpec(type)),
        fill: '{"type":"solid","color":"#ffffff","style":"solid"}',
        color: '#1e1e1e',
    };
}

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
});

async function render(node: ReturnType<typeof createElement>) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(node));
    cleanups.push(async () => {
        await act(async () => root.unmount());
        container.remove();
    });
    return container;
}

const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
// The grid opens on A1, as a sheet does, so B2 is selected first.
const typeInB2 = async (value: string) => {
    const b2 = dialog()?.querySelector('[role="row"][aria-rowindex="3"] > [aria-colindex="3"]');
    await act(async () => b2?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
    await type(dialog()?.querySelector<HTMLInputElement>('input[data-cell-editor]') ?? null, value);
};
const buttonIn = (scope: ParentNode | undefined, label: string) =>
    [...(scope?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((el) => el.textContent?.trim() === label);
const click = async (target: HTMLElement | undefined) => {
    if (!target) throw new Error('nothing to click');
    await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const type = async (input: HTMLInputElement | null, value: string) => {
    if (!input) throw new Error('no field to type in');
    await act(async () => {
        input.focus();
        setValue?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

describe('newChartElement', () => {
    // The canvas' insertChart: one sealed addElement of this partial at the viewport center.
    const insert = (type: ChartType, viewport: 'infinite' | 'frame', style: StyleDefaults) => {
        const doc = new Y.Doc();
        const undoManager = new Y.UndoManager(doc.getMap('elements'));
        sealed(undoManager, () =>
            writeElementInDoc(doc, newChartElement(type, { x: 960, y: 540 }, viewport, style), 'a0', style),
        );
        return { doc, undoManager, inserted: readVectorFromDoc(doc).elements };
    };

    test("a drawing's chart is 640 × 400 on the viewport center, rough and in Excalifont, one undo step", () => {
        const { undoManager, inserted, doc } = insert('bar', 'infinite', VECTOR_STYLE_DEFAULTS);
        expect(inserted).toHaveLength(1);
        const [el] = inserted;
        expect(el).toMatchObject({ type: 'chart', x: 640, y: 340, width: 640, height: 400 });
        expect(readChartSpec(el).spec).toEqual(sampleChartSpec('bar', 'Excalifont'));
        expect(el.roughness).toBe(VECTOR_STYLE_DEFAULTS.roughness);
        expect(undoManager.undoStack).toHaveLength(1);
        undoManager.undo();
        expect(readVectorFromDoc(doc).elements).toEqual([]);
    });

    test("a slide's chart is 1200 × 675, flat and in Inter", () => {
        const { inserted } = insert('pie', 'frame', SLIDES_STYLE_DEFAULTS);
        const [el] = inserted;
        expect(el).toMatchObject({ type: 'chart', x: 360, y: 202.5, width: 1200, height: 675 });
        expect(readChartSpec(el).spec).toEqual(sampleChartSpec('pie', 'Inter'));
        expect(el.roughness).toBe(SLIDES_STYLE_DEFAULTS.roughness);
    });
});

describe('ChartPanelSection', () => {
    const section = async (elements: VectorElement[], beginGesture?: () => () => void) => {
        const writes: Record<string, unknown>[] = [];
        const replaced: unknown[][] = [];
        const panel = createElement(ChartPanelSection, {
            elements,
            scene: new Map(elements.map((el) => [el.id, el])),
            onChange: (fields: Record<string, unknown>) => writes.push(fields),
            onChangeEach: () => {},
            onReplace: (shapes: unknown[]) => replaced.push(shapes),
        });
        const container = await render(
            beginGesture ? createElement(PropertyGestureContext.Provider, { value: beginGesture }, panel) : panel,
        );
        return { container, writes, replaced };
    };

    test('one selected chart shows its editor with Edit data', async () => {
        const { container } = await section([chart('c1')]);
        expect([...container.querySelectorAll('h4')].map((h) => h.textContent)).toContain('Chart');
        expect(buttonIn(container, 'Edit data')).toBeDefined();
    });

    test("Convert to shapes replaces the chart with its layout's shapes", async () => {
        const { container, replaced, writes } = await section([chart('c1')]);
        await click(buttonIn(container, 'Convert to shapes'));
        expect(replaced).toHaveLength(1);
        expect(replaced[0].length).toBeGreaterThan(10);
        expect(writes).toEqual([]);
    });

    test('two charts, or one whose spec does not parse, show no chart rows', async () => {
        expect((await section([chart('c1'), chart('c2')])).container.textContent).toBe('');
        expect((await section([{ ...chart('c1'), specData: '{' }])).container.textContent).toBe('');
    });

    test('an edit writes the one part it changed', async () => {
        const { container, writes } = await section([chart('c1')]);
        await type(container.querySelector('input[placeholder="Chart title"]'), 'Goals');
        expect(writes).toEqual([{ specTitle: '{"text":"Goals"}' }]);
    });

    test("a title edit keeps what this build doesn't know in its part", async () => {
        const { container, writes } = await section([{ ...chart('c1'), specTitle: '{"text":"","future":1}' }]);
        await type(container.querySelector('input[placeholder="Chart title"]'), 'Goals');
        expect(writes).toEqual([{ specTitle: '{"text":"Goals","future":1}' }]);
    });

    test('Edit data saves the grid as one write; Cancel writes nothing', async () => {
        const { container, writes } = await section([chart('c1')]);
        await click(buttonIn(container, 'Edit data'));
        await typeInB2('7');
        await click(buttonIn(dialog(), 'Save'));
        expect(writes.map(Object.keys)).toEqual([['specData']]);
        const { spec } = readChartSpec({ ...chart('c1'), ...writes[0] });
        expect(spec?.data.source === 'inline' && spec.data.series[0].values[0]).toBe(7);

        await click(buttonIn(container, 'Edit data'));
        await typeInB2('8');
        await click(buttonIn(dialog(), 'Cancel'));
        expect(writes).toHaveLength(1);
    });
});

describe('ChartEditDialog', () => {
    // What a double-click on a chart opens.
    const open = async () => {
        const writes: Record<string, unknown>[] = [];
        let closed = 0;
        await render(
            createElement(ChartEditDialog, {
                element: chart('c1'),
                onChange: (fields: Record<string, unknown>) => writes.push(fields),
                onClose: () => {
                    closed += 1;
                },
            }),
        );
        return { writes, closed: () => closed };
    };

    test('opens the data grid at once; Save writes the chart and closes', async () => {
        const { writes, closed } = await open();
        expect(dialog()?.textContent).toContain('Edit data');
        await click(buttonIn(dialog(), 'Save'));
        expect(writes).toHaveLength(1);
        expect(closed()).toBe(1);
    });

    test('Cancel closes without a write', async () => {
        const { writes, closed } = await open();
        await click(buttonIn(dialog(), 'Cancel'));
        expect(writes).toEqual([]);
        expect(closed()).toBe(1);
    });

    test("Save applies onto the element as it is then, so a peer's colours and title while it was open stay", async () => {
        const writes: Record<string, unknown>[] = [];
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        cleanups.push(async () => {
            await act(async () => root.unmount());
            container.remove();
        });
        const show = (element: VectorChartElement) =>
            act(async () =>
                root.render(
                    createElement(ChartEditDialog, {
                        element,
                        onChange: (fields: Record<string, unknown>) => writes.push(fields),
                        onClose: () => {},
                    }),
                ),
            );
        await show(chart('c1'));
        const spec = sampleChartSpec('column');
        const peer = {
            ...spec,
            title: { text: 'Peer title' },
            series: { ...spec.series, 's-2': { ...DEFAULT_CHART_SERIES_STYLE, color: '#00ff00' } },
            points: { 's-1': { 1: { color: '#000002' } } },
        };
        const peerParts = { ...chart('c1'), ...newChartSpecParts(peer) };
        await show(peerParts);
        await typeInB2('7');
        await click(buttonIn(dialog(), 'Save'));
        const saved = readChartSpec({ ...peerParts, ...writes[0] }).spec;
        expect(saved?.title.text).toBe('Peer title');
        expect(saved?.points).toEqual({ 's-1': { 1: { color: '#000002' } } });
        expect(['s-1', 's-2', 's-3'].map((id) => saved?.series[id].color)).toEqual([null, '#00ff00', null]);
        expect(saved?.data.source === 'inline' && saved.data.series[0].values[0]).toBe(7);
    });
});

test('a font picked in the panel is one write of the spec and one undo step', async () => {
    const doc = new Y.Doc();
    const element = doc.getMap('element');
    const undoManager = new Y.UndoManager(element);
    const el = chart('c1');
    const panel = createElement(ChartPanelSection, {
        elements: [el],
        scene: new Map([[el.id, el]]),
        onChange: (fields: Record<string, unknown>) =>
            sealed(undoManager, () => {
                for (const [key, value] of Object.entries(fields)) element.set(key, value);
            }),
        onChangeEach: () => {},
        onReplace: () => {},
    });
    const container = await render(
        createElement(PropertyGestureContext.Provider, { value: () => holdCapture(undoManager) }, panel),
    );
    const trigger = [...container.querySelectorAll('span.w-14')]
        .find((span) => span.textContent?.trim() === 'Font')
        ?.nextElementSibling?.querySelector('button[aria-haspopup="menu"]');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const serif = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === 'Source Serif 4',
    );
    await click(serif);
    expect(readChartSpec({ ...el, ...element.toJSON() }).spec?.chart.fontFamily).toBe('Source Serif 4');
    expect([...element.keys()]).toEqual(['specChart']);
    expect(undoManager.undoStack).toHaveLength(1);
    undoManager.undo();
    expect(element.get('specChart')).toBeUndefined();
});

test('a typed chart title through the panel is one undo step', async () => {
    const doc = new Y.Doc();
    const element = doc.getMap('element');
    const undoManager = new Y.UndoManager(element);
    const el = chart('c1');
    const panel = createElement(ChartPanelSection, {
        elements: [el],
        scene: new Map([[el.id, el]]),
        onChange: (fields: Record<string, unknown>) =>
            sealed(undoManager, () => {
                for (const [key, value] of Object.entries(fields)) element.set(key, value);
            }),
        onChangeEach: () => {},
        onReplace: () => {},
    });
    const container = await render(
        createElement(PropertyGestureContext.Provider, { value: () => holdCapture(undoManager) }, panel),
    );
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Chart title"]');
    for (const typed of ['G', 'Go', 'Goa', 'Goal']) await type(input, typed);
    await act(async () => input?.dispatchEvent(new Event('focusout', { bubbles: true })));
    expect(readChartSpec({ ...el, ...element.toJSON() }).spec?.title.text).toBe('Goal');
    expect(undoManager.undoStack).toHaveLength(1);
});

describe('two peers on one chart, through the panel and the canvas writer', () => {
    const REMOTE = 'remote';
    type Canvas = ReturnType<typeof useCanvasDoc>;

    // Two docs that start in step, each with a canvas and its panel over the chart; neither hears the other until
    // sync, so both edit the chart as it was.
    const peers = async () => {
        const a = new Y.Doc();
        const b = new Y.Doc();
        writeElementInDoc(a, { type: 'chart', width: 640, height: 400 }, 'a0', VECTOR_STYLE_DEFAULTS, 'c1');
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a), REMOTE);
        peerDocs.set('a', a);
        peerDocs.set('b', b);
        const canvases = new Map<string, Canvas>();
        function Peer({ mountId }: { mountId: string }) {
            const canvas = useCanvasDoc('owner', mountId, 'drawing', VECTOR_STYLE_DEFAULTS);
            canvases.set(mountId, canvas);
            return createElement(CanvasPropertiesPanel, {
                elements: canvas.elements,
                selectedElements: canvas.elements,
                updateElements: canvas.updateElements,
                reorderElements: canvas.reorderElements,
                replaceElement: canvas.replaceElement,
                setSelectedIds: () => {},
                undoManager: canvas.undoManager,
                aspectLocked: false,
                onAspectLockChange: () => {},
            });
        }
        const panelA = await render(createElement(Peer, { mountId: 'a' }));
        const panelB = await render(createElement(Peer, { mountId: 'b' }));
        const sync = () =>
            act(async () => {
                Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), REMOTE);
                Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), REMOTE);
            });
        const specIn = (doc: Y.Doc) => {
            const [el] = readVectorFromDoc(doc).elements;
            return el ? readChartSpec(el).spec : null;
        };
        const undo = (mountId: string) => act(async () => canvases.get(mountId)?.undoManager?.undo());
        return { a, b, panelA, panelB, sync, specIn, undo };
    };

    const setTitle = async (panel: HTMLElement, value: string) => {
        const input = panel.querySelector<HTMLInputElement>('input[placeholder="Chart title"]');
        await type(input, value);
        await act(async () => input?.dispatchEvent(new Event('focusout', { bubbles: true })));
    };
    // The first palette swatch other than the series' own, so the pick is a change.
    const recolor = async (panel: HTMLElement, series: string) => {
        const span = [...panel.querySelectorAll('span.w-14')].find((s) => s.textContent?.trim() === series);
        const trigger = span?.nextElementSibling?.querySelector('button');
        await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const swatch = [
            ...document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button[title^="#"]'),
        ].at(-1);
        if (!swatch) throw new Error('the color popover has no swatch');
        await click(swatch);
        return swatch.title;
    };

    test('a title on one and a series colour on the other: both kept on both', async () => {
        const { a, b, panelA, panelB, sync, specIn } = await peers();
        await setTitle(panelA, 'Goals');
        const color = await recolor(panelB, 'Bulb (incandescent)');
        await sync();
        for (const doc of [a, b]) {
            expect(specIn(doc)?.title.text).toBe('Goals');
            expect(specIn(doc)?.series['s-2'].color).toBe(color);
        }
    });

    // The colour lands after the title, on the chart the title is in, so one field would hold both and ⌘Z couldn't
    // take the title back without the colour.
    test('⌘Z of the title through the canvas undo scope leaves the colour a peer set after it', async () => {
        const { a, b, panelA, panelB, sync, specIn, undo } = await peers();
        await setTitle(panelA, 'Goals');
        await sync();
        const color = await recolor(panelB, 'Bulb (incandescent)');
        await sync();
        await undo('a');
        await sync();
        for (const doc of [a, b]) {
            expect(specIn(doc)?.title.text).toBe(sampleChartSpec('column').title.text);
            expect(specIn(doc)?.series['s-2'].color).toBe(color);
        }
    });

    test("a newer build's part stays on the element through an edit, and the canvas reads it", async () => {
        const { a, panelA } = await peers();
        const stored = a.getMap('elements').get('c1');
        if (!(stored instanceof Y.Map)) throw new Error('no chart');
        await act(async () => stored.set('specFuture', '{"a":1}'));
        await setTitle(panelA, 'Goals');
        expect(stored.get('specFuture')).toBe('{"a":1}');
        const [el] = readVectorFromDoc(a).elements;
        expect(el && prop(el, 'specFuture')).toBe('{"a":1}');
    });

    test("Edit data's series delete on one and a recolour on the other: both kept on both", async () => {
        const { a, b, panelA, panelB, sync, specIn } = await peers();
        await click(buttonIn(panelA, 'Edit data'));
        const header = [...(dialog()?.querySelectorAll<HTMLElement>('[role="columnheader"]') ?? [])].find(
            (el) => el.textContent === 'B',
        );
        await act(async () =>
            header?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1 })),
        );
        const editor = dialog()?.querySelector('input[data-cell-editor]');
        await act(async () =>
            editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })),
        );
        await click(buttonIn(dialog(), 'Save'));
        const color = await recolor(panelB, 'Bulb (incandescent)');
        await sync();
        for (const doc of [a, b]) {
            const spec = specIn(doc);
            expect(spec?.data.series.map((series) => series.id)).toEqual(['s-2', 's-3']);
            expect(spec?.series['s-2'].color).toBe(color);
        }
    });
});
