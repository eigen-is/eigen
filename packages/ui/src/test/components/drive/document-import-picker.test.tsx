// The import endpoint answers only once the file is transformed into the document, and the picker has
// closed by then. What is pinned here is that the blocking progress dialog covers that wait, for an
// upload from the device and a pick from Drive alike.
import { expect, mock, test } from 'bun:test';
import { XLSX_MIME } from '@workspace/lib/constants/mime';
import { DRIVE_MIME_SHEETS } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const pending = { device: false, drive: false };

const realDrive = await import('@workspace/lib/drive');
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useDriveViewPreferences: () => ({ sortKey: 'name', sortDir: 'asc' }),
    useImportDocument: () => ({ mutate: () => {}, isPending: pending.device }),
    useImportFromDrive: () => ({ mutate: () => {}, isPending: pending.drive }),
}));
mock.module('@workspace/lib/auth', () => ({ useAuth: () => ({ user: { id: 'owner-1' } }) }));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DocumentImportPicker } = await import('../../../components/drive/document-import-picker');

const path = drivePath({ name: 'Budget.eigensheets', mimeType: DRIVE_MIME_SHEETS });

async function dialogTitleWhile(state: typeof pending): Promise<string | null> {
    Object.assign(pending, state);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(DocumentImportPicker, {
                path,
                open: false,
                onOpenChange: () => {},
                title: 'Import xlsx file',
                progressTitle: 'Importing xlsx file',
                mime: XLSX_MIME,
                accept: '.xlsx',
            }),
        );
    });
    // Radix portals the dialog to the body.
    const title = document.querySelector('[role="dialog"] h2')?.textContent ?? null;
    await act(async () => root.unmount());
    container.remove();
    return title;
}

test('no dialog shows while nothing imports', async () => {
    expect(await dialogTitleWhile({ device: false, drive: false })).toBeNull();
});

test('the progress dialog shows while a device file imports', async () => {
    expect(await dialogTitleWhile({ device: true, drive: false })).toBe('Importing xlsx file');
});

test('the progress dialog shows while a Drive file imports', async () => {
    expect(await dialogTitleWhile({ device: false, drive: true })).toBe('Importing xlsx file');
});
