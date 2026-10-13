import { afterEach, expect, test } from 'bun:test';
import { sampleChartSpec } from '@workspace/lib/charts';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Op = import('../../../state').Op;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

const BOX = { x: 10, y: 20, width: 400, height: 300 };

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mountWorkbook() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<WorkbookInstance>();
    const sent: Op[][] = [];
    await act(async () => {
        root.render(
            createElement(Workbook, {
                ref,
                data: [{ id: 's1', name: 'One', order: 0, row: 20, column: 5, celldata: [], config: {} }],
                showToolbar: false,
                showFormulaBar: false,
                onOp: (ops: Op[]) => sent.push(ops),
            }),
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const workbook = () => {
        if (!ref.current) throw new Error('workbook did not mount');
        return ref.current;
    };
    const step = (run: (w: WorkbookInstance) => void) =>
        act(async () => {
            run(workbook());
        });
    const charts = () => workbook().getAllSheets()[0].charts;
    return { sent, step, charts };
}

const peerDeletes = (id: string): Op[] => [{ op: 'remove', id: 's1', path: ['charts', id] }];

test('a mounted workbook starts every sheet with a charts map', async () => {
    const { charts } = await mountWorkbook();
    expect(charts()).toEqual({});
});

test('undoing a move of a chart a peer deleted drops the entry and sends nothing', async () => {
    const { sent, step, charts } = await mountWorkbook();
    let id = '';
    await step((w) => {
        id = w.insertChart(BOX, sampleChartSpec('column'));
    });
    await step((w) => w.updateChartBox(id, { x: 300 }));
    await step((w) => w.applyOp(peerDeletes(id)));
    const before = sent.length;
    await step((w) => w.undo());
    expect(charts()).toEqual({});
    expect(sent.length).toBe(before);
    // The next entry is the insert's own, whose undo still applies.
    await step((w) => w.undo());
    expect(sent.at(-1)).toEqual(peerDeletes(id));
});

test('redoing a move of a chart a peer deleted drops the entry', async () => {
    const { sent, step, charts } = await mountWorkbook();
    let id = '';
    await step((w) => {
        id = w.insertChart(BOX, sampleChartSpec('column'));
    });
    await step((w) => w.updateChartBox(id, { x: 300 }));
    await step((w) => w.undo());
    await step((w) => w.applyOp(peerDeletes(id)));
    const before = sent.length;
    await step((w) => w.redo());
    expect(charts()).toEqual({});
    expect(sent.length).toBe(before);
});
