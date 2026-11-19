// Mod+Z undoes the board or the canvas from anywhere on the page, except from a text field, which undoes its own typing:
// an input, a textarea or a rich-text editor such as an open card's description.
import { afterEach, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import * as Y from 'yjs';
import { useYjsUndoHotkeys } from '../../../../core/collab/hooks/use-yjs-undo-hotkeys';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

let unmount = async () => {};
afterEach(() => unmount());

async function board() {
    const doc = new Y.Doc();
    const tasks = doc.getMap<string>('tasks');
    const undoManager = new Y.UndoManager(tasks);
    tasks.set('card-1', 'Print wristbands');
    ({ unmount } = await renderHook(() => useYjsUndoHotkeys(undoManager, true), new QueryClient()));
    return tasks;
}

function pressUndo(target: Element) {
    const mac = /mac/i.test(`${navigator.platform} ${navigator.userAgent}`);
    target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true }),
    );
}

function field(html: string): Element {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    document.body.append(holder);
    const target = holder.querySelector('[data-target]');
    if (!target) throw new Error('no target');
    return target;
}

test('Mod+Z on the page undoes the last change', async () => {
    const tasks = await board();
    pressUndo(document.body);
    expect(tasks.has('card-1')).toBe(false);
});

test('Mod+Z in an input or a rich-text editor leaves the board alone', async () => {
    const tasks = await board();
    pressUndo(field('<input data-target>'));
    pressUndo(field('<textarea data-target></textarea>'));
    pressUndo(field('<div contenteditable="true"><p data-target>Two colors</p></div>'));
    expect(tasks.get('card-1')).toBe('Print wristbands');
});
