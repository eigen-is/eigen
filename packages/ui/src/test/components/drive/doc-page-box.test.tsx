// Quick look and the Drive thumbnail draw an eigendoc on the docs page, so both size their page box from the
// one page setup the editor uses: the same width, and the page's margins as its padding.
import { expect, mock, test } from 'bun:test';
import { DEFAULT_PAGE_SETUP, pageBoxStyle } from '@workspace/lib/docs/eigendoc';
import { subjectFromPath } from '@workspace/lib/file-subject';
import { DRIVE_MIME_DOC, DRIVE_TYPE_DOC, type DrivePath } from '@workspace/lib/types/drive';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'owner-1' } };
mock.module('@workspace/lib/auth', () => ({ useAuth: () => session, useIsGuest: () => false }));

const realDrive = await import('@workspace/lib/drive');
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useTextPreview: () => ({ data: { mode: 'eigendoc', body: '<p>Quarterly report</p>' }, isLoading: false }),
}));

const { createElement } = await import('react');
const { PreviewContext } = await import('../../../components/preview-provider/preview-context');
const { FilePreview } = await import('../../../components/drive/file-preview');
const { DrivePreview } = await import('../../../components/drive/drive-preview');

const path: DrivePath = {
    id: 'path-1',
    mountId: 'default',
    name: 'Quarterly report.eigendoc',
    type: DRIVE_TYPE_DOC,
    parentId: null,
    ownerId: 'owner-1',
    mimeType: DRIVE_MIME_DOC,
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

const preview = { openPreview: () => {}, updatePreview: () => {}, closePreview: () => {}, isPreviewOpen: true };

// The page box as the browser reads the setup's style back, so the comparison is CSSOM's, not a string's.
function expectPageBox(el: HTMLElement | null | undefined) {
    const expected = document.createElement('div');
    Object.assign(expected.style, pageBoxStyle(DEFAULT_PAGE_SETUP));
    expect(el?.style.width).toBe(expected.style.width);
    expect(el?.style.padding).toBe(expected.style.padding);
}

test('quick look draws an eigendoc on the docs page', async () => {
    const subject = subjectFromPath(path);
    const { container, unmount } = await renderInDocument(
        createElement(
            PreviewContext.Provider,
            { value: preview },
            createElement(FilePreview, {
                subject,
                siblings: [subject],
                onClose: () => {},
                onPrev: () => {},
                onNext: () => {},
            }),
        ),
    );
    expectPageBox(container.querySelector<HTMLElement>('.eigen-prose')?.parentElement);
    await unmount();
});

test('the Drive thumbnail draws an eigendoc on the docs page', async () => {
    const { container, unmount } = await renderInDocument(createElement(DrivePreview, { path }));
    expectPageBox(container.querySelector<HTMLElement>('.eigen-prose'));
    await unmount();
});
