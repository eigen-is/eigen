// The three states a typed-payload quick look reaches before its payload are one switch, so a `.vcf`, an
// `.eml` and an `.ics` say the same things. What is pinned here is which of them a query that has not
// answered yet reaches: a query still disabled (the owner is not known until auth settles) has no data
// and is not fetching either, and must read as loading rather than as a file that could not be read.
import { expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

type QueryResult = { data: undefined; status: 'pending' | 'error' | 'success' };

const served: { result: QueryResult } = { result: { data: undefined, status: 'pending' } };

const realDrive = await import('@workspace/lib/drive');
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useVCardPreview: () => served.result,
    useEmlPreview: () => served.result,
    useIcsPreview: () => served.result,
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { VCardPreviewContent } = await import('../../../components/drive/vcard-preview-content');
const { EmlPreviewContent } = await import('../../../components/drive/eml-preview-content');
const { IcsPreviewContent } = await import('../../../components/drive/ics-preview-content');

const path: DrivePath = {
    id: 'path-1',
    mountId: 'default',
    name: 'Autumn market.ics',
    type: 'file',
    parentId: null,
    ownerId: 'owner-1',
    mimeType: 'text/calendar',
    size: 2048,
    hash: null,
    thumbnail: null,
    acl: null,
    visibility: 'private',
    sharingRestricted: false,
    details: null,
    trashedAt: null,
    createdAt: new Date('2026-09-20T09:00:00Z'),
    updatedAt: new Date('2026-09-20T09:00:00Z'),
};

const contents = [VCardPreviewContent, EmlPreviewContent, IcsPreviewContent];

async function renderAll(): Promise<string[]> {
    const texts: string[] = [];
    for (const Content of contents) {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(createElement(Content, { path }));
        });
        texts.push(container.textContent ?? '');
        await act(async () => root.unmount());
        container.remove();
    }
    return texts;
}

test('a query that has not answered yet reads as loading, not as an unreadable file', async () => {
    served.result = { data: undefined, status: 'pending' };
    for (const text of await renderAll()) expect(text).not.toContain('Could not read this file');
});

test('a query that failed reads as an unreadable file', async () => {
    served.result = { data: undefined, status: 'error' };
    for (const text of await renderAll()) expect(text).toContain('Could not read this file');
});
