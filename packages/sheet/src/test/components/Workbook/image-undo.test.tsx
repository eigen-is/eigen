import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

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
    await act(async () => {
        root.render(
            createElement(Workbook, {
                ref,
                data: [{ id: 's1', name: 'One', order: 0, row: 20, column: 5, celldata: [], config: {} }],
                showToolbar: false,
                showFormulaBar: false,
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
    const images = () => workbook().getAllSheets()[0].images ?? {};
    const mediaNames = () => Object.values(images()).map((image) => image.mediaName);
    return { step, images, mediaNames };
}

test('a mounted workbook starts every sheet with an images map', async () => {
    const { images } = await mountWorkbook();
    expect(images()).toEqual({});
});

// The swap of an upload's pending name records no undo step, so the insert's own entry still holds the pending name:
// a redo must not bring back an image whose name never resolves.
test('redoing an insert whose upload settled brings the image back under its real name', async () => {
    const { step, mediaNames } = await mountWorkbook();
    await step((w) => w.insertImage('pending:a', 40, 30));
    await step((w) => w.replaceImageMediaName('pending:a', 'photo.png'));
    await step((w) => w.undo());
    expect(mediaNames()).toEqual([]);
    await step((w) => w.redo());
    expect(mediaNames()).toEqual(['photo.png']);
});

test('an upload that settles while its insert is undone still names the redone image', async () => {
    const { step, mediaNames } = await mountWorkbook();
    await step((w) => w.insertImage('pending:a', 40, 30));
    await step((w) => w.undo());
    await step((w) => w.replaceImageMediaName('pending:a', 'photo.png'));
    await step((w) => w.redo());
    expect(mediaNames()).toEqual(['photo.png']);
});

test('undoing the delete of an image whose upload settled brings it back under its real name', async () => {
    const { step, images, mediaNames } = await mountWorkbook();
    await step((w) => w.insertImage('pending:a', 40, 30));
    const [id] = Object.keys(images());
    await step((w) => w.deleteFloatingObject({ kind: 'image', id }));
    await step((w) => w.replaceImageMediaName('pending:a', 'photo.png'));
    await step((w) => w.undo());
    expect(mediaNames()).toEqual(['photo.png']);
});
