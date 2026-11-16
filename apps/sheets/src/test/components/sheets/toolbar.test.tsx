// The File menu hands the focus back to the cell editor as it closes, as the workbook's own menus do, so the next key
// acts on the grid. The workbook's refocus handler and the File menu render as probes, since they are tested where
// they live.
import { afterAll, expect, mock, test } from 'bun:test';
import { DRIVE_MIME_SHEETS } from '@workspace/lib/types/drive';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const refocusCellEditor = () => {};
const seen: { onCloseAutoFocus?: unknown } = {};

// Copies, because mock.module rewrites a loaded module's exports in place.
const realSheet = { ...(await import('@workspace/sheet')) };
const realUi = { ...(await import('@workspace/ui/components/layout/toolbar')) };
const realDrive = { ...(await import('@workspace/ui/components/drive')) };
const Nothing = () => null;
mock.module('@workspace/sheet', () => ({ ...realSheet, useCellEditorRefocus: () => refocusCellEditor }));
mock.module('@workspace/ui/components/layout/toolbar', () => ({
    ...realUi,
    FileMenu: ({ onCloseAutoFocus }: { onCloseAutoFocus?: unknown }) => {
        seen.onCloseAutoFocus = onCloseAutoFocus;
        return null;
    },
}));
mock.module('@workspace/ui/components/drive', () => ({
    ...realDrive,
    DocumentImportPicker: Nothing,
    ExportProgressDialog: Nothing,
    useDocumentExport: () => ({ exportPath: () => {}, isExporting: false }),
}));
afterAll(() => {
    mock.module('@workspace/sheet', () => realSheet);
    mock.module('@workspace/ui/components/layout/toolbar', () => realUi);
    mock.module('@workspace/ui/components/drive', () => realDrive);
});

const { createElement } = await import('react');
const { ToolbarLeftItems } = await import('../../../components/sheets/toolbar');

test('the File menu returns the focus to the cell editor as it closes', async () => {
    const { unmount } = await renderInDocument(
        createElement(ToolbarLeftItems, {
            path: drivePath({ name: 'Budget', mimeType: DRIVE_MIME_SHEETS }),
            canWrite: true,
            onAccessDialogOpen: () => {},
        }),
    );
    expect(seen.onCloseAutoFocus).toBe(refocusCellEditor);
    await unmount();
});
