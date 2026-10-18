// The import endpoint answers only once the file is transformed into the document, and the picker has
// closed by then. What is pinned here is that the blocking progress dialog covers that wait, for an
// upload from the device and a pick from Drive alike, and which Drive rows the picker offers.
import { expect, mock, test } from 'bun:test';
import { PPTX_MIME } from '@workspace/lib/constants/mime';
import { DRIVE_MIME_SHEETS, DRIVE_MIME_SLIDES, type DrivePath } from '@workspace/lib/types/drive';
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
const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
const browsed: { canPick?: (item: DrivePath) => boolean } = {};
mock.module('../../../components/drive/drive-browser', () => ({
    DriveBrowser: ({ canPick }: { canPick?: (item: DrivePath) => boolean }) => {
        browsed.canPick = canPick;
        return null;
    },
}));

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
                target: 'eigensheets',
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

// Drive stores the type the uploader claimed, and a .pptx often arrives as application/octet-stream, so a row is
// offered by its extension, as Convert takes it.
test('a .pptx in Drive is pickable in the slides import, whatever type its upload claimed', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(DocumentImportPicker, {
                path,
                open: true,
                onOpenChange: () => {},
                title: 'Import slides',
                progressTitle: 'Importing slides',
                target: 'eigenslides',
            }),
        );
    });
    const pickable = (name: string, mimeType: string) => browsed.canPick?.(drivePath({ name, mimeType }));
    expect(pickable('Quarterly review.pptx', 'application/octet-stream')).toBe(true);
    expect(pickable('Quarterly review.PPTX', PPTX_MIME)).toBe(true);
    expect(pickable('Budget.xlsx', 'application/octet-stream')).toBe(false);
    expect(pickable('Deck.eigenslides', DRIVE_MIME_SLIDES)).toBe(false);
    await act(async () => root.unmount());
    container.remove();
});
