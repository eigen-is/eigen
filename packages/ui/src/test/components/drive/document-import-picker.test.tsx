// The import endpoint answers only once the file is transformed into the document, and the picker has
// closed by then. What is pinned here is that the blocking progress dialog covers that wait, for an
// upload from the device and a pick from Drive alike, which Drive rows the picker offers, and that a pick
// runs no import until the dialog after it says how the file comes in.
import { expect, mock, test } from 'bun:test';
import { PPTX_MIME } from '@workspace/lib/constants/mime';
import type { ConvertTarget, DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_SHEETS, DRIVE_MIME_SLIDES } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const pending = { device: false, drive: false };
const fromDrive: unknown[] = [];

const realDrive = await import('@workspace/lib/drive');
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useDriveViewPreferences: () => ({ sortKey: 'name', sortDir: 'asc' }),
    useImportDocument: () => ({ mutate: () => {}, isPending: pending.device }),
    useImportFromDrive: () => ({ mutate: (variables: unknown) => fromDrive.push(variables), isPending: pending.drive }),
}));
const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
const browsed: { canPick?: (item: DrivePath) => boolean; onConfirm?: (item: DrivePath) => void } = {};
mock.module('../../../components/drive/drive-browser', () => ({
    DriveBrowser: ({ canPick, onConfirm }: typeof browsed) => {
        browsed.canPick = canPick;
        browsed.onConfirm = onConfirm;
        return null;
    },
}));

const { act, createElement, useState } = await import('react');
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

// The picker as a File menu holds it: open until a pick closes it.
function Host({ target, file }: { target: ConvertTarget; file: string }) {
    const [open, setOpen] = useState(true);
    return createElement(DocumentImportPicker, {
        path: drivePath({ name: file, mimeType: DRIVE_MIME_SHEETS }),
        open,
        onOpenChange: setOpen,
        target,
        afterFrameId: 'fr-current',
    });
}

async function pickFromDrive(target: ConvertTarget, name: string): Promise<() => Promise<void>> {
    fromDrive.length = 0;
    Object.assign(pending, { device: false, drive: false });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Host, { target, file: 'Open document' })));
    await act(async () => browsed.onConfirm?.(drivePath({ id: 'picked', name, mimeType: 'application/octet-stream' })));
    return async () => {
        await act(async () => root.unmount());
        container.remove();
    };
}

const dialog = () => document.querySelector('[role="dialog"]');
const radios = () =>
    [...document.querySelectorAll('[role="radio"]')].map((radio) => radio.getAttribute('aria-checked'));
async function click(text: string): Promise<void> {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!button) throw new Error(`no ${text} button`);
    await act(async () => button.click());
}

test('a pick runs nothing until Import, and a deck inserts after the current slide by default', async () => {
    const unmount = await pickFromDrive('eigenslides', 'Quarterly review.pptx');
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Import pptx file');
    expect(dialog()?.textContent).toContain('Quarterly review.pptx');
    expect(dialog()?.textContent).toContain('Insert slides');
    expect(dialog()?.textContent).toContain('Replace all slides');
    expect(radios()).toEqual(['true', 'false']);
    expect(fromDrive).toEqual([]);
    await click('Import');
    expect(fromDrive).toEqual([
        expect.objectContaining({ sourcePathId: 'picked', options: { mode: 'insert', afterFrameId: 'fr-current' } }),
    ]);
    expect(dialog()).toBeNull();
    await unmount();
});

test('a spreadsheet can replace instead, and Cancel imports nothing', async () => {
    let unmount = await pickFromDrive('eigensheets', 'Budget.xlsx');
    expect(dialog()?.textContent).toContain('Insert as new sheets');
    await act(async () => (document.querySelectorAll('[role="radio"]')[1] as HTMLElement).click());
    await click('Import');
    expect(fromDrive).toEqual([expect.objectContaining({ options: expect.objectContaining({ mode: 'replace' }) })]);
    await unmount();

    unmount = await pickFromDrive('eigensheets', 'Budget.xlsx');
    await click('Cancel');
    expect(fromDrive).toEqual([]);
    expect(dialog()).toBeNull();
    await unmount();
});

test('a doc offers no choice: it warns that the file replaces the document, a version saved first', async () => {
    const unmount = await pickFromDrive('eigendoc', 'Report.docx');
    expect(radios()).toEqual([]);
    expect(dialog()?.textContent).toContain('Report.docx replaces this whole document');
    expect(dialog()?.textContent).toContain('version history');
    await click('Import');
    expect(fromDrive).toEqual([expect.objectContaining({ options: expect.objectContaining({ mode: 'replace' }) })]);
    await unmount();
});
