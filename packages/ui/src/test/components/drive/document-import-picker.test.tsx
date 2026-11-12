// The import endpoint answers only once the file is transformed into the document, and the picker has
// closed by then. What is pinned here is that the blocking progress dialog covers that wait, for an
// upload from the device and a pick from Drive alike, which Drive rows the picker offers, and that a pick
// runs no import until the dialog after it says how the file comes in. That dialog waits for the import, and a failed
// one leaves it open for another try. A canceled one keeps naming the file while it fades out.
import { expect, mock, test } from 'bun:test';
import { PPTX_MIME } from '@workspace/lib/constants/mime';
import type { ConvertTarget, DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_SHEETS, DRIVE_MIME_SLIDES } from '@workspace/lib/types/drive';
import { holdClosingDialogs } from '../../closing-dialog';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const pending = { device: false, drive: false };
const fromDrive: unknown[] = [];
// How the next import from Drive ends, once it has been recorded.
let importEnds: () => Promise<void> = async () => {};

const realDrive = await import('@workspace/lib/drive');
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useDriveViewPreferences: () => ({ sortKey: 'name', sortDir: 'asc' }),
    useImportDocument: () => ({ mutateAsync: async () => {}, isPending: pending.device }),
    useImportFromDrive: () => ({
        mutateAsync: async (variables: unknown) => {
            fromDrive.push(variables);
            await importEnds();
        },
        isPending: pending.drive,
    }),
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
const { onMutationError } = await import('@workspace/lib/api-error');
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
    importEnds = async () => {};
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
    await act(async () => document.querySelectorAll<HTMLElement>('[role="radio"]')[1]?.click());
    await click('Import');
    expect(fromDrive).toEqual([expect.objectContaining({ options: expect.objectContaining({ mode: 'replace' }) })]);
    await unmount();

    unmount = await pickFromDrive('eigensheets', 'Budget.xlsx');
    await click('Cancel');
    expect(fromDrive).toEqual([]);
    expect(dialog()).toBeNull();
    await unmount();
});

test('a canceled choice keeps naming the file while it closes', async () => {
    const release = holdClosingDialogs();
    const unmount = await pickFromDrive('eigensheets', 'Budget.xlsx');
    try {
        // The picker closed on the pick and is held too, so the choice is the open one.
        const choice = document.querySelector('[role="dialog"][data-state="open"]');
        const cancel = [...(choice?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Cancel');
        await act(async () => cancel?.click());
        expect(choice?.getAttribute('data-state')).toBe('closed');
        expect(choice?.querySelector('p')?.textContent).toBe('Budget.xlsx');
    } finally {
        release();
        await unmount();
    }
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

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);

test('the choice waits while the import runs, then closes', async () => {
    const unmount = await pickFromDrive('eigensheets', 'Budget.xlsx');
    let finish = () => {};
    importEnds = () => new Promise<void>((resolve) => (finish = resolve));
    await click('Import');
    expect(fromDrive).toHaveLength(1);
    expect(button('Import')?.disabled).toBe(true);
    expect(button('Cancel')?.disabled).toBe(true);
    await act(async () => finish());
    expect(dialog()).toBeNull();
    await unmount();
});

test('an import that fails keeps the choice open for another try', async () => {
    const unmount = await pickFromDrive('eigensheets', 'Budget.xlsx');
    importEnds = async () => {
        // The mutation hook toasts its failure before the dialog sees it.
        const failure = new Error('offline');
        onMutationError(failure);
        throw failure;
    };
    await act(async () => document.querySelectorAll<HTMLElement>('[role="radio"]')[1]?.click());
    await click('Import');
    expect(fromDrive).toHaveLength(1);
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Import xlsx file');
    expect(radios()).toEqual(['false', 'true']);
    expect(button('Import')?.disabled).toBe(false);

    importEnds = async () => {};
    await click('Import');
    expect(fromDrive).toEqual([
        expect.objectContaining({ options: expect.objectContaining({ mode: 'replace' }) }),
        expect.objectContaining({ options: expect.objectContaining({ mode: 'replace' }) }),
    ]);
    expect(dialog()).toBeNull();
    await unmount();
});
