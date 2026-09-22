// "Upload from device" clicks a hidden input that lives next to the dialog, not inside its portal. What is
// pinned here is that the picker stays open until a file is actually chosen: closing it on the click unmounts
// that input wherever a caller renders the picker conditionally (the calendar sidebar does), and the native
// chooser then never opens.
import { expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const realDrive = await import('@workspace/lib/drive');
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useDriveViewPreferences: () => ({ sortKey: 'name', sortDir: 'asc' }),
}));
mock.module('@workspace/lib/auth', () => ({ useAuth: () => ({ user: { id: 'owner-1' } }) }));
mock.module('../../../components/drive/drive-browser', () => ({ DriveBrowser: () => null }));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DrivePickerWithUpload } = await import('../../../components/drive/drive-picker-with-upload');

async function open() {
    const picked: File[][] = [];
    const opened: boolean[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(DrivePickerWithUpload, {
                open: true,
                onOpenChange: (next: boolean) => opened.push(next),
                title: 'Import events',
                accept: 'text/calendar',
                onPickFromDrive: (_paths: DrivePath[]) => {},
                onPickFromDevice: (files: File[]) => picked.push(files),
            }),
        );
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clicks = { count: 0 };
    input.addEventListener('click', () => {
        clicks.count += 1;
    });

    // Radix portals the dialog to the body.
    const dialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1) as HTMLElement;
    const clickUpload = async () => {
        const button = [...dialog().querySelectorAll('button')].find(
            (el) => el.textContent?.trim() === 'Upload from device',
        );
        if (!button) throw new Error(`no upload button; saw ${dialog().textContent}`);
        await act(async () => {
            button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const chooseFile = async (file: File) => {
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        await act(async () => {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };
    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { chooseFile, cleanup, clicks, clickUpload, opened, picked };
}

test('the upload button clicks the hidden input and leaves the picker open', async () => {
    const { cleanup, clicks, clickUpload, opened } = await open();

    await clickUpload();
    expect(clicks.count).toBe(1);
    expect(opened).toEqual([]);
    await cleanup();
});

test('a chosen file reaches the caller and closes the picker', async () => {
    const { chooseFile, cleanup, clickUpload, opened, picked } = await open();

    await clickUpload();
    await chooseFile(new File(['BEGIN:VCALENDAR'], 'Autumn market.ics', { type: 'text/calendar' }));
    expect(picked.map((files) => files.map((file) => file.name))).toEqual([['Autumn market.ics']]);
    expect(opened).toEqual([false]);
    await cleanup();
});
