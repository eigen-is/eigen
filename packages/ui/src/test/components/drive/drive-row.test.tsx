// A Drive row's ⋮ button opens the item's menu and its Shared cell opens Share. Tab skips both, since the table's
// menu key opens the same menu, which holds Share. A click still opens each.
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }),
);
afterAll(() => fetchSpy.mockRestore());

const { act, createElement, createRef } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { useLongPress } = await import('../../../hooks/use-long-press');
const { DriveRow } = await import('../../../components/drive/drive-row');
const { useDriveItemController } = await import('../../../components/drive/use-drive-item-controller');

const item = drivePath({ id: 'file-1', name: 'Plan.txt', type: 'file', mimeType: 'text/plain' });
const seen: { controller: ReturnType<typeof useDriveItemController> | null } = { controller: null };
const onShareClick = mock((_item: DrivePath) => {});

function Row() {
    const controller = useDriveItemController({ items: [item], containerRef: createRef<HTMLElement>() });
    seen.controller = controller;
    const { bind } = useLongPress<DrivePath>(() => {});
    return createElement(DriveRow, {
        item,
        index: 0,
        isActive: false,
        isSelected: false,
        disabled: false,
        gridCols: '',
        coarse: false,
        controller,
        longPressBind: bind,
        onShareClick,
    });
}

function button(label: string): HTMLButtonElement {
    const found = document.querySelector(`button[aria-label="${label}"]`);
    if (!(found instanceof HTMLButtonElement)) throw new Error(`the row has no ${label} button`);
    return found;
}

test('Tab skips the ⋮ and the Share button, and a click still opens the menu and Share', async () => {
    await renderInDocument(createElement(AuthProvider, null, createElement(Row)));
    expect(button('More actions').tabIndex).toBe(-1);
    expect(button('Share').tabIndex).toBe(-1);
    await act(async () => button('More actions').click());
    expect(seen.controller?.contextMenu.item?.id).toBe('file-1');
    await act(async () => button('Share').click());
    expect(onShareClick).toHaveBeenCalledWith(item);
});
