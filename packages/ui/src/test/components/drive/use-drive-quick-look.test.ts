// Space in a Drive listing, the document apps' lists included, previews only what the menu's Quick preview
// row offers: a file, never a folder.
import { expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { useDriveQuickLook } = await import('../../../components/drive/use-drive-quick-look');
const { PreviewContext } = await import('../../../components/preview-provider/preview-context');

function previewed(path: DrivePath): string[] {
    const opened: string[] = [];
    let quickLook: (path: DrivePath, siblings: DrivePath[]) => void = () => {};
    function Probe() {
        quickLook = useDriveQuickLook(true);
        return null;
    }
    const value = {
        openPreview: (subject: { drive?: DrivePath }) => opened.push(subject.drive?.id ?? ''),
        updatePreview: () => {},
        closePreview: () => {},
        isPreviewOpen: false,
    };
    renderToStaticMarkup(createElement(PreviewContext.Provider, { value }, createElement(Probe)));
    quickLook(path, [path]);
    return opened;
}

test('Space previews a document', () => {
    const doc = drivePath({ id: 'doc-1', name: 'Plan.eigendoc', type: 'doc', mimeType: 'application/eigendoc' });
    expect(previewed(doc)).toEqual(['doc-1']);
});

test('Space does not preview a folder', () => {
    const folder = drivePath({ id: 'folder-1', name: 'Plans', type: 'folder', mimeType: 'inode/directory' });
    expect(previewed(folder)).toEqual([]);
});
