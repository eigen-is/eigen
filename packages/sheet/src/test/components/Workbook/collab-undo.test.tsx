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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function mount(onOp: (ops: Op[]) => void) {
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
    cleanups.push(async () => {
        await act(async () => root.unmount());
        container.remove();
    });
    return () => {
        if (!ref.current) throw new Error('workbook did not mount');
        return ref.current;
    };
}

// Two tabs relay their batches to each other, as the op log does. A third tab inserts two rows above row 3; the
// Workbook has no insert of its own on its API, so the batch comes from the editor's own record.
test("undo after a peer's row insert lands on the moved cell in both tabs", async () => {
    let b: () => WorkbookInstance = () => {
        throw new Error('not mounted');
    };
    const a = await mount((ops) => b().applyOp(ops));
    b = await mount((ops) => a().applyOp(ops));
    const step = (run: () => void) => act(async () => run());

    await step(() => a().setCellFormat(9, 1, 'bl', 1));
    const op = { type: 'row', index: 2, count: 2, direction: 'lefttop', id: 's1' } as const;
    const base = workbookContextFactory({ sheets: a().getAllSheets(), currentSheetId: 's1' });
    const { ops } = author(base, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
    await step(() => {
        a().applyOp(ops);
        b().applyOp(ops);
    });
    expect(a().getFlowdata()?.[11]?.[1]?.bl).toBe(1);

    await step(() => a().undo());
    for (const tab of [a(), b()]) {
        expect(tab.getFlowdata()?.[11]?.[1]).toMatchObject({ v: 'old' });
        expect(tab.getFlowdata()?.[11]?.[1]?.bl).toBeFalsy();
        expect(tab.getFlowdata()?.[9]?.[1]).toBeNull();
    }
});
