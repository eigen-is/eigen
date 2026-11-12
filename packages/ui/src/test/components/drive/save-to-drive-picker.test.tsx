// After a partial failure, Save to Drive retries only the files that failed, so the ones that copied don't
// land twice, and its title counts what is left. Opening the picker again saves the full list. The picker is
// driven through the file-action runner that owns it, as every host does.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
// A copy, because mock.module rewrites the loaded module in place, and afterAll puts the original back for the
// field's own test.
const realLocationField = { ...(await import('../../../components/drive/drive-location-field')) };
mock.module('../../../components/drive/drive-location-field', () => ({ DriveLocationField: () => null }));
afterAll(() => mock.module('../../../components/drive/drive-location-field', () => realLocationField));

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// The source ids the copy route was asked for, in order. The source `bad` always fails.
const posted: string[] = [];
beforeEach(() => {
    posted.length = 0;
    g.fetch = async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        const sourceId = /\/path\/([^/]+)\/copy$/.exec(url)?.[1];
        // The runner's other hooks read too, such as the viewer's teams.
        if (!sourceId) return Response.json([]);
        posted.push(sourceId);
        if (sourceId === 'bad') return new Response('Server error', { status: 500 });
        return Response.json(drivePath({ id: `copy-of-${sourceId}`, name: 'copy.png', mimeType: 'image/png' }));
    };
});

const { act, createElement } = await import('react');
const { useFileActionRunner } = await import('../../../components/file-actions/use-file-action-runner');
const { PreviewContext } = await import('../../../components/preview-provider/preview-context');

let unmount = async () => {};
afterEach(() => unmount());

const subjects: FileSubject[] = ['good', 'bad'].map((id) => ({
    drive: drivePath({ id, name: `${id}.png`, mimeType: 'image/png', parentId: 'folder' }),
}));

const preview = { openPreview: () => {}, updatePreview: () => {}, closePreview: () => {}, isPreviewOpen: false };
let openPicker: (subjects: FileSubject[]) => void = () => {};

function Runner() {
    const runner = useFileActionRunner(null);
    openPicker = runner.openPicker;
    return runner.dialogs;
}

async function openSaveToDrive() {
    ({ unmount } = await renderInDocument(
        createElement(PreviewContext.Provider, { value: preview }, createElement(Runner)),
    ));
    await act(async () => openPicker(subjects));
}

async function save() {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Save here');
    if (!button) throw new Error('no save button');
    await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

const title = () => document.querySelector('[role="dialog"] h2')?.textContent;

test('a retry after a partial failure posts only the failed file', async () => {
    await openSaveToDrive();
    expect(title()).toBe('Save 2 files to Drive');
    await save();
    expect(posted).toEqual(['good', 'bad']);
    expect(title()).toBe('Save to Drive');
    posted.length = 0;
    await save();
    expect(posted).toEqual(['bad']);
});

test('opening the picker again saves the full list again', async () => {
    await openSaveToDrive();
    await save();
    await act(async () => openPicker(subjects));
    expect(title()).toBe('Save 2 files to Drive');
    posted.length = 0;
    await save();
    expect(posted).toEqual(['good', 'bad']);
});
