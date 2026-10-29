import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const { insertRowCol } = await import('../../../state/modules/rowcol');
const { author } = await import('../../state/factories/collab');
const { workbookContextFactory } = await import('../../state/factories/context');
type Op = import('../../../state').Op;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

// Each step runs inside one act(), so React renders only once the step ends. A read or a batch the test sees inside
// the step comes from the call itself.
async function mountWorkbook(onOp: (ops: Op[]) => void) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<WorkbookInstance>();
    await act(async () => {
        root.render(
            createElement(Workbook, {
                ref,
                data: [
                    {
                        id: 's1',
                        name: 'One',
                        order: 0,
                        row: 20,
                        column: 5,
                        celldata: [{ r: 9, c: 1, v: { v: 'old', m: 'old' } }],
                        config: {},
                    },
                ],
                showToolbar: false,
                showFormulaBar: false,
                onOp,
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
    return { workbook, step };
}

const paths = (ops: Op[]) => ops.map(({ op, path }) => `${op} ${path.join('/')}`);

test('a read right after an edit sees the edit before React renders', async () => {
    const { step } = await mountWorkbook(() => {});
    let bold: unknown;
    let sheetBold: unknown;
    await step((w) => {
        w.setCellFormat(9, 1, 'bl', 1);
        bold = w.getFlowdata()?.[9]?.[1]?.bl;
        sheetBold = w.getAllSheets()[0].data?.[9]?.[1]?.bl;
    });
    expect(bold).toBe(1);
    expect(sheetBold).toBe(1);
});

test('each edit sends its batch once, during its call, in call order', async () => {
    const log: string[] = [];
    const { step } = await mountWorkbook((ops) => log.push(...paths(ops)));
    await step((w) => {
        w.setCellFormat(0, 0, 'bl', 1);
        log.push('returned');
        w.setCellFormat(1, 0, 'bl', 1);
        log.push('returned');
    });
    expect(log).toEqual(['replace data/0/0', 'returned', 'replace data/1/0', 'returned']);
});

test('an undo right after an edit sends one batch that takes the edit back', async () => {
    const sent: Op[][] = [];
    const { step, workbook } = await mountWorkbook((ops) => sent.push(ops));
    let sentByUndo = 0;
    await step((w) => {
        w.setCellFormat(9, 1, 'bl', 1);
        const before = sent.length;
        w.undo();
        sentByUndo = sent.length - before;
    });
    expect(sentByUndo).toBe(1);
    expect(sent).toHaveLength(2);
    expect(paths(sent[1])).toEqual(['remove data/9/1/bl']);
    expect(workbook().getFlowdata()?.[9]?.[1]?.bl).toBeFalsy();
});

// A peer inserts two rows above row 3 between two local edits. The first edit's batch goes out before the peer's
// applies, its cell moves with the insert, and its undo follows it there.
test("a peer's batch between two local edits keeps the batches and the workbook in call order", async () => {
    const log: string[] = [];
    const { step, workbook } = await mountWorkbook((ops) => log.push(...paths(ops)));
    const op = { type: 'row', index: 2, count: 2, direction: 'lefttop', id: 's1' } as const;
    const base = workbookContextFactory({ sheets: workbook().getAllSheets(), currentSheetId: 's1' });
    const { ops: peer } = author(base, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op });

    let moved: unknown;
    await step((w) => {
        w.setCellFormat(9, 1, 'bl', 1);
        log.push('peer');
        w.applyOp(peer);
        moved = w.getFlowdata()?.[11]?.[1];
        w.setCellFormat(9, 1, 'it', 1);
    });
    expect(log).toEqual(['add data/9/1/bl', 'peer', 'replace data/9/1']);
    expect(moved).toMatchObject({ v: 'old', bl: 1 });
    expect(workbook().getFlowdata()?.[11]?.[1]).toMatchObject({ v: 'old', bl: 1 });
    expect(workbook().getFlowdata()?.[9]?.[1]?.it).toBe(1);

    await step((w) => w.undo());
    await step((w) => w.undo());
    expect(workbook().getFlowdata()?.[11]?.[1]).toMatchObject({ v: 'old' });
    expect(workbook().getFlowdata()?.[11]?.[1]?.bl).toBeFalsy();
    expect(workbook().getFlowdata()?.[9]?.[1]?.it).toBeFalsy();
});
