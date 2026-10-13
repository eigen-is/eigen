// The canvas toolbar is the deck's and the drawing's. Only the deck brings slides in from a file, so its File menu
// alone holds Import slides…, and the drawing's File menu has no import row at all.
import { afterEach, expect, mock, test } from 'bun:test';
import { DRIVE_MIME_SLIDES, DRIVE_MIME_VECTOR } from '@workspace/lib/types/drive';
import type { CanvasHandle } from '../../../components/vector/canvas-editor';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// The File menu publishes its actions to ⌘K and navigates after a delete; neither is under test here.
const realPalette = await import('@workspace/lib/command-palette');
mock.module('@workspace/lib/command-palette', () => ({ ...realPalette, usePaletteSelectionActions: () => {} }));
const realRouter = await import('@tanstack/react-router');
mock.module('@tanstack/react-router', () => ({ ...realRouter, useNavigate: () => () => {} }));
const session = { user: { id: 'owner-1' } };
mock.module('@workspace/lib/auth', () => ({ useAuth: () => session, useIsGuest: () => false }));

const { act, createElement, createRef } = await import('react');
const { Presentation, PenTool } = await import('lucide-react');
const { DocSearchProvider } = await import('../../../components/search/doc-search-provider');
const { CanvasToolbar } = await import('../../../components/vector/canvas-toolbar');

let unmount = async () => {};
afterEach(() => unmount());

async function fileMenuEntries(props: Partial<Parameters<typeof CanvasToolbar>[0]>): Promise<string[]> {
    const toolbar = createElement(CanvasToolbar, {
        path: drivePath({ name: 'Deck.eigenslides', mimeType: DRIVE_MIME_SLIDES }),
        canWrite: true,
        canEdit: true,
        offline: false,
        storageUnavailable: false,
        undoManager: null,
        tool: 'select',
        setTool: () => {},
        toolLocked: false,
        setToolLocked: () => {},
        canvasRef: createRef<CanvasHandle>(),
        onAccessDialogOpen: () => {},
        onToggleCommentPanel: () => {},
        commentPanelOpen: false,
        assignedCommentCount: 0,
        onToggleActivityPanel: () => {},
        activityPanelOpen: false,
        createLabel: 'New slides',
        createIcon: Presentation,
        createType: 'slides',
        ...props,
    });
    const controller = { search: () => [], highlightAll: () => {}, reveal: () => {} };
    ({ unmount } = await renderInDocument(createElement(DocSearchProvider, { controller, children: toolbar })));
    const file = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent?.trim() === 'File',
    );
    await act(async () => {
        file?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    return [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
        (entry) => entry.textContent?.trim() ?? '',
    );
}

test("the deck's File menu imports slides", async () => {
    const entries = await fileMenuEntries({ onImport: () => {}, importLabel: 'Import slides…' });
    expect(entries).toContain('Import slides…');
});

test("the drawing's File menu has no import", async () => {
    const entries = await fileMenuEntries({
        path: drivePath({ name: 'Sketch.eigenvector', mimeType: DRIVE_MIME_VECTOR }),
        createLabel: 'New vector',
        createIcon: PenTool,
        createType: 'vector',
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.startsWith('Import'))).toBe(false);
});
