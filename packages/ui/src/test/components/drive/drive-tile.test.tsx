// A grid tile has a ⋮ button that opens the item's menu. A mouse user sees it on hover only. Tab skips it, since the
// grid's menu key opens the same menu. The keyboard cursor on a tile looks apart from a selected tile.
import { expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { expectKeyboardReveal } from '../../hover-reveal';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { useLongPress } = await import('../../../hooks/use-long-press');
const { DriveTile } = await import('../../../components/drive/drive-tile');
const { useDriveItemController } = await import('../../../components/drive/use-drive-item-controller');

const item = drivePath({ id: 'file-1', name: 'Plan.txt', type: 'file', mimeType: 'text/plain' });
const seen: { controller: ReturnType<typeof useDriveItemController> | null } = { controller: null };

type TileState = { isActive?: boolean; isCursor?: boolean; isSelected?: boolean };

function Tile({ isActive = false, isCursor = false, isSelected = false }: TileState) {
    const controller = useDriveItemController({ items: [item], containerRef: createRef<HTMLElement>() });
    seen.controller = controller;
    const { bind } = useLongPress<DrivePath>(() => {});
    return createElement(DriveTile, {
        item,
        isActive,
        isCursor,
        isSelected,
        disabled: false,
        controller,
        longPressBind: bind,
    });
}

test('the ⋮ button shows on hover only, Tab skips it, and a click opens the item’s menu', async () => {
    await renderInDocument(createElement(Tile));
    const button = document.querySelector('button[aria-label="More actions"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('the tile has no ⋮ button');
    expectKeyboardReveal(button);
    expect(button.tabIndex).toBe(-1);
    await act(async () => button.click());
    expect(seen.controller?.contextMenu.item?.id).toBe('file-1');
});

test('the cursor tile draws the cursor stripe without the selected border, and a selected one under it draws both', async () => {
    const tileClasses = async (state: TileState) => {
        const { container, unmount } = await renderInDocument(createElement(Tile, state));
        const tile = container.querySelector('.eigen-tile');
        if (!(tile instanceof HTMLElement)) throw new Error('no tile rendered');
        await unmount();
        return {
            cursor: tile.classList.contains('eigen-tile-cursor'),
            selected: tile.classList.contains('eigen-tile-selected'),
        };
    };
    expect(await tileClasses({ isCursor: true })).toEqual({ cursor: true, selected: false });
    expect(await tileClasses({ isSelected: true })).toEqual({ cursor: false, selected: true });
    expect(await tileClasses({ isCursor: true, isSelected: true })).toEqual({ cursor: true, selected: true });
});
