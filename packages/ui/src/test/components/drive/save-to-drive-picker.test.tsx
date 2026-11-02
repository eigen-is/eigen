// After a partial failure, Save to Drive retries only the files that failed, so the ones that copied don't
// land twice, and its title counts what is left. Closing the picker forgets the failure.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('../../../components/drive/drive-location-field', () => ({ DriveLocationField: () => null }));

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// The source ids the copy route was asked for, in order. The source `bad` always fails.
const posted: string[] = [];
beforeEach(() => {
    posted.length = 0;
    g.fetch = async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        const sourceId = /\/path\/([^/]+)\/copy$/.exec(url)?.[1] ?? '';
        posted.push(sourceId);
        if (sourceId === 'bad') return new Response('Server error', { status: 500 });
        return Response.json(drivePath({ id: `copy-of-${sourceId}`, name: 'copy.png', mimeType: 'image/png' }));
    };
});

const { act, createElement, useState } = await import('react');
const { SaveToDrivePicker } = await import('../../../components/drive/save-to-drive-picker');

let unmount = async () => {};
afterEach(() => unmount());

const subjects: FileSubject[] = ['good', 'bad'].map((id) => ({
    drive: drivePath({ id, name: `${id}.png`, mimeType: 'image/png', parentId: 'folder' }),
}));

let setOpen: (open: boolean) => void = () => {};

function Host() {
    const [open, set] = useState(true);
    setOpen = set;
    return createElement(SaveToDrivePicker, { subjects, open, onClose: () => set(false) });
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
    ({ unmount } = await renderInDocument(createElement(Host)));
    expect(title()).toBe('Save 2 files to Drive');
    await save();
    expect(posted).toEqual(['good', 'bad']);
    expect(title()).toBe('Save to Drive');
    posted.length = 0;
    await save();
    expect(posted).toEqual(['bad']);
});

test('closing and reopening the picker saves the full list again', async () => {
    ({ unmount } = await renderInDocument(createElement(Host)));
    await save();
    await act(async () => setOpen(false));
    await act(async () => setOpen(true));
    expect(title()).toBe('Save 2 files to Drive');
    posted.length = 0;
    await save();
    expect(posted).toEqual(['good', 'bad']);
});
