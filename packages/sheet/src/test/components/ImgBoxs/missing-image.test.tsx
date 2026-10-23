import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

// An image whose file is gone draws as missing, and must still select like any image, so Delete removes it.
test('a missing image selects on click and Delete removes it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            status: 1,
            row: 20,
            column: 5,
            celldata: [],
            config: {},
            images: { gone: { id: 'gone', index: 'a0', mediaName: 'gone.png', x: 10, y: 10, width: 50, height: 50 } },
        },
    ];
    await act(async () => {
        root.render(
            createElement(Workbook, {
                data,
                showToolbar: false,
                showFormulaBar: false,
                hooks: { resolveImageUrl: () => null, isImageMissing: () => true },
            }),
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };

    const image = container.querySelector<HTMLElement>('#gone');
    if (!image) throw new Error('the missing image did not draw');
    await act(async () => image.click());
    expect(container.querySelector('#sheet-modal-dialog-activeImage')).not.toBeNull();

    // The key goes where the user's focus is, so the selected image must hold it.
    await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(container.querySelector('#gone')).toBeNull();
    expect(container.querySelector('#sheet-modal-dialog-activeImage')).toBeNull();
});
