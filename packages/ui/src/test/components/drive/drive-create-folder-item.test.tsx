// Every editor's File menu mounts the rename dialog closed, so the Location line's breadcrumb is read
// only once the dialog opens.
import { afterEach, expect, test } from 'bun:test';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

const requests: string[] = [];
g.fetch = async (input: string | URL | Request) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return Response.json([]);
};

const { createElement } = await import('react');
const { DriveCreateItemDialog } = await import('../../../components/drive/drive-create-folder-item');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    requests.length = 0;
});

async function render(open: boolean) {
    ({ unmount } = await renderInDocument(
        createElement(DriveCreateItemDialog, {
            open,
            onOpenChange: () => {},
            onCreateItem: () => {},
            type: 'Rename',
            path: drivePath({ name: 'Notes.eigendoc', mimeType: DRIVE_MIME_DOC }),
        }),
    ));
}

test('a closed dialog reads no breadcrumb', async () => {
    await render(false);
    expect(requests).toEqual([]);
});

test('an open dialog reads the breadcrumb of its path', async () => {
    await render(true);
    expect(requests).toEqual([expect.stringContaining('/path-1/breadcrumb')]);
});
