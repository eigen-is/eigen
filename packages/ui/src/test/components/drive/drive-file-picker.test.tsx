// The file picker keeps the dialog contract: it opens on its list, Cmd+Enter hands the picked file on once, and Esc,
// the X, a click outside and Cancel close it at once, since a pick is not typed input. A second Cmd+Enter while it
// fades out hands nothing more on. The folder browser itself is drawn for real in its own test.
import { afterAll, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { closingDialog, holdClosingDialogs } from '../../closing-dialog';
import { drivePath } from '../../drive-path';
import { expectFormContract, field } from '../../form-contract';
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
// The list the picker draws, and the way to pick a row in it.
let pickRow = (_path: DrivePath) => {};
mock.module('../../../components/drive/drive-browser', () => ({
    DriveBrowser: ({ onSelect }: { onSelect?: (path: DrivePath) => void }) => {
        pickRow = (path) => onSelect?.(path);
        return <div role="grid" aria-label="Files" tabIndex={0} />;
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('../../../components/drive/drive-browser', () => realBrowser);
});

const { act, useState } = await import('react');
const { DriveFilePicker } = await import('../../../components/drive/drive-file-picker');

const notes = drivePath({ id: 'notes', name: 'Notes.txt', mimeType: 'text/plain' });
const onSelect = mock((_paths: DrivePath[]) => {});

function Host() {
    const [open, setOpen] = useState(true);
    return <DriveFilePicker open={open} onOpenChange={setOpen} onSelect={onSelect} title="Open a file" />;
}

test('the file picker keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => <Host />,
        submitLabel: 'Select',
        firstField: 'Files',
        onSubmit: onSelect,
        makeChanged: async () => act(async () => pickRow(notes)),
        savesAtOnce: true,
        except: { discard: 'a pick is not typed input, so a close never asks' },
    });
});

test('a second Cmd+Enter while the picker fades out hands nothing more on', async () => {
    const letGo = holdClosingDialogs();
    onSelect.mockClear();
    const { unmount } = await renderInDocument(<Host />);
    try {
        await act(async () => pickRow(notes));
        const press = () =>
            act(async () => {
                field('Files').dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
                );
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        await press();
        expect(closingDialog()).not.toBeNull();
        await press();
        expect(onSelect.mock.calls).toEqual([[[notes]]]);
    } finally {
        letGo();
        await unmount();
    }
});
