// The "import one file" picker says Import, as Import events and Import contacts open it, and waits for a pick; then
// its button or Cmd+Enter hands the file on. A pick that is a step before the import, such as a document's Import…,
// names its own verb.
import { afterAll, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realBrowser = { ...(await import('../../../components/drive/drive-browser')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useDriveViewPreferences: () => ({ sortKey: 'name', sortDir: 'asc' }),
}));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: { id: 'owner-1' } }) }));
// The way to pick a row, read from the browser the picker draws.
let pickRow = (_path: DrivePath) => {};
mock.module('../../../components/drive/drive-browser', () => ({
    DriveBrowser: ({ onSelect }: { onSelect?: (path: DrivePath) => void }) => {
        pickRow = (path) => onSelect?.(path);
        return null;
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('../../../components/drive/drive-browser', () => realBrowser);
});

const { act, createElement } = await import('react');
const { FileImportPicker } = await import('../../../components/drive/file-import-picker');

const market = drivePath({ id: 'market', name: 'Autumn market.ics', mimeType: 'text/calendar' });

async function open(submitLabel?: string) {
    const picked: DrivePath[] = [];
    const { unmount } = await renderInDocument(
        createElement(FileImportPicker, {
            open: true,
            onOpenChange: () => {},
            title: 'Import events',
            submitLabel,
            accept: '.ics',
            canPick: () => true,
            onDeviceFile: () => {},
            onDrivePick: (item: DrivePath) => picked.push(item),
            pending: false,
            progressTitle: 'Importing events',
        }),
    );
    const footer = () => [...document.querySelectorAll('[role="dialog"] [data-slot="dialog-footer"] button')];
    return { picked, unmount, labels: () => footer().map((b) => b.textContent), footer };
}

test('Import events says Import and waits for a pick', async () => {
    const { labels, footer, unmount } = await open();
    expect(labels()).toEqual(['Upload from device', 'Cancel', 'Import']);
    expect(footer().at(-1)?.hasAttribute('disabled')).toBe(true);
    await unmount();
});

test('after a pick, Cmd+Enter hands the file on', async () => {
    const { picked, footer, unmount } = await open();
    await act(async () => pickRow(market));
    expect(footer().at(-1)?.hasAttribute('disabled')).toBe(false);
    await act(async () => {
        footer()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(picked).toEqual([market]);
    await unmount();
});

test('a pick before the import names its own verb', async () => {
    const { labels, unmount } = await open('Select');
    expect(labels()).toEqual(['Upload from device', 'Cancel', 'Select']);
    await unmount();
});

test("a phone's footer shows only the icon of Upload from device, and a screen reader still reads its name", async () => {
    const { footer, unmount } = await open();
    const label = [...(footer()[0]?.querySelectorAll('span') ?? [])].find(
        (span) => span.textContent === 'Upload from device',
    );
    expect(label?.classList.contains('max-sm:sr-only')).toBe(true);
    await unmount();
});
