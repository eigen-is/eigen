// A document whose stored data is gone never loads, so the loading surface is where the way back shows.
// What is pinned here is who is offered which way: a writer gets the version list to restore from, and a
// reader, who cannot restore, is not told to.
import { expect, mock, test } from 'bun:test';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { drivePath } from '../../../drive-path';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

const versions: Snapshot[] = [
    { id: 'v2', name: 'v2', createdAt: new Date('2025-09-21T10:00:00Z'), size: 4096 },
    { id: 'v1', name: 'v1', createdAt: new Date('2025-09-20T09:00:00Z'), size: 2048 },
];

const realVersioning = await import('@workspace/lib/versioning');
mock.module('@workspace/lib/versioning', () => ({
    ...realVersioning,
    useVersions: () => ({ data: versions }),
    useRestoreVersion: () => ({ mutateAsync: async () => {} }),
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { formatDateTime } = await import('@workspace/lib/date');
const { CollabLoadingState } = await import('../../../../components/layout/app/collab-loading-state');
const { CollabDocumentGate } = await import('../../../../components/layout/app/collab-document-gate');

const path = drivePath({ name: 'Minutes.eigendoc', mimeType: DRIVE_MIME_DOC });

async function goneScreen(canWrite: boolean): Promise<{ text: string; rows: string[] }> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(CollabLoadingState, {
                storageUnavailable: false,
                storageGone: true,
                loadError: null,
                path,
                canWrite,
            }),
        );
    });
    const text = container.textContent ?? '';
    const rows = [...container.querySelectorAll('button')].map((button) => button.textContent ?? '');
    await act(async () => root.unmount());
    container.remove();
    return { text, rows };
}

test('a writer sees the gone message with a version to restore per row', async () => {
    const { text, rows } = await goneScreen(true);
    expect(text).toContain('The stored data for this document could not be found.');
    expect(text).toContain('Restore a version from its history');
    expect(rows).toEqual(versions.map((snap) => `${formatDateTime(snap.createdAt)}Restore`));
});

test('a reader sees the gone message without the version list or the restore instruction', async () => {
    const { text, rows } = await goneScreen(false);
    expect(text).toContain('The stored data for this document could not be found.');
    expect(text).not.toContain('Restore a version from its history');
    expect(text).toContain('Ask someone who can edit it to restore a version');
    expect(rows).toEqual([]);
});

test("a document that can't be shown ends in the server's message under the gate, with no spinner", async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const collab = {
        loaded: false,
        storageUnavailable: false,
        storageGone: false,
        loadError: 'Document too large to show',
    };
    await act(async () => {
        root.render(createElement(CollabDocumentGate, { collab, path, canWrite: false, children: 'the editor' }));
    });
    expect(container.textContent).toBe('Document too large to show');
    expect(container.querySelector('svg')).toBeNull();
    await act(async () => root.unmount());
    container.remove();
});
