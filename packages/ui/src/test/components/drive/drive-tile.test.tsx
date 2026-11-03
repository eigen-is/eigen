// A grid tile has a ⋮ button that opens the item's menu. A mouse user sees it on hover only, and Tab reaches and
// shows it.
import { test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { expectKeyboardReveal } from '../../hover-reveal';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { createElement, createRef } = await import('react');
const { useLongPress } = await import('../../../hooks/use-long-press');
const { DriveTile } = await import('../../../components/drive/drive-tile');
const { useDriveItemController } = await import('../../../components/drive/use-drive-item-controller');

const item = drivePath({ id: 'file-1', name: 'Plan.txt', type: 'file', mimeType: 'text/plain' });

function Tile() {
    const controller = useDriveItemController({ items: [item], containerRef: createRef<HTMLElement>() });
    const { bind } = useLongPress<DrivePath>(() => {});
    return createElement(DriveTile, {
        item,
        isActive: false,
        isSelected: false,
        disabled: false,
        controller,
        longPressBind: bind,
    });
}

test('the ⋮ button shows on hover only, and Tab reaches and shows it', async () => {
    await renderInDocument(createElement(Tile));
    const button = document.querySelector('button[aria-label="More actions"]');
    if (!button) throw new Error('the tile has no ⋮ button');
    expectKeyboardReveal(button);
});
