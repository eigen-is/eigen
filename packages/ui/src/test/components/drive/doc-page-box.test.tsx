// Quick look and the Drive thumbnail draw an eigendoc on the docs page, so both size their page box from the
// one page setup the editor uses: the same width, and the page's margins as its padding.
import { expect, mock, test } from 'bun:test';
import { subjectFromPath } from '@workspace/lib/file-subject';
import { DRIVE_MIME_DOC, DRIVE_TYPE_DOC } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

// happy-dom lays nothing out, so the thumbnail test re-stubs the hero's rect and fires the observers itself.
const resizeCallbacks: (() => void)[] = [];
installHappyDom({ onResizeObserver: (callback) => resizeCallbacks.push(callback) });

const session = { user: { id: 'owner-1' } };
mock.module('@workspace/lib/auth', () => ({ useAuth: () => session, useIsGuest: () => false }));

const realDrive = await import('@workspace/lib/drive');
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useTextPreview: () => ({ data: { mode: 'eigendoc', body: '<p>Quarterly report</p>' }, isLoading: false }),
}));

const { act, createElement } = await import('react');
const { PreviewContext } = await import('../../../components/preview-provider/preview-context');
const { FilePreview } = await import('../../../components/drive/file-preview');
const { DrivePreview } = await import('../../../components/drive/drive-preview');

const path = drivePath({
    name: 'Quarterly report.eigendoc',
    type: DRIVE_TYPE_DOC,
    mimeType: DRIVE_MIME_DOC,
    size: 2048,
});

const preview = { openPreview: () => {}, updatePreview: () => {}, closePreview: () => {}, isPreviewOpen: true };

function expectPageBox(el: HTMLElement | null | undefined, width: string) {
    expect(el?.style.width).toBe(width);
    expect(el?.style.padding).toBe('20mm');
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
    expectPageBox(container.querySelector<HTMLElement>('.eigen-prose')?.parentElement, '210mm');
    await unmount();
});

test('the Drive thumbnail draws an eigendoc on the docs page', async () => {
    const { container, unmount } = await renderInDocument(createElement(DrivePreview, { path }));
    expectPageBox(container.querySelector<HTMLElement>('.eigen-prose'), '793.700787px');
    await unmount();
});

test('the Drive thumbnail scales the docs page to the hero', async () => {
    // Drop the earlier tests' disconnected observers, which would fire with no entries at all.
    resizeCallbacks.length = 0;
    const { container, unmount } = await renderInDocument(createElement(DrivePreview, { path }));
    const hero = container.querySelector<HTMLElement>('.drive-preview-hero');
    if (!hero) throw new Error('the thumbnail rendered no hero');
    hero.getBoundingClientRect = () => new DOMRect(0, 0, 240, 180);
    act(() => {
        for (const callback of resizeCallbacks) callback();
    });

    // 240 px over A4's 793.70 px (210 mm at 96 dpi).
    const transform = container.querySelector<HTMLElement>('.eigen-prose')?.style.transform;
    expect(Number(transform?.match(/^scale\((.+)\)$/)?.[1])).toBeCloseTo(0.302381, 6);
    await unmount();
});
