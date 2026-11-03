// A contextmenu event as each browser sends it, for the code that tells a key's from a pointer's. A key's reports no
// button, which reads as 0: Chrome with the mouse's pointerType, Firefox with an empty one, and Firefox before 129 as a
// plain MouseEvent. A right-click reports button 2. A Mac's Ctrl+click in Firefox and a long press in Chrome report 0.

export type ContextMenuSource =
    | 'chrome-key'
    | 'firefox-key'
    | 'old-firefox-key'
    | 'right-click'
    | 'ctrl-click'
    | 'long-press';

export function contextMenuEvent(source: ContextMenuSource): MouseEvent {
    const init = { bubbles: true, cancelable: true };
    switch (source) {
        case 'chrome-key':
            return new PointerEvent('contextmenu', { ...init, pointerType: 'mouse', button: 0 });
        case 'firefox-key':
            return new PointerEvent('contextmenu', { ...init, pointerType: '', button: 0 });
        case 'old-firefox-key':
            return new MouseEvent('contextmenu', { ...init, button: 0 });
        case 'right-click':
            return new PointerEvent('contextmenu', { ...init, pointerType: 'mouse', button: 2 });
        case 'ctrl-click':
            return new PointerEvent('contextmenu', { ...init, pointerType: 'mouse', button: 0, ctrlKey: true });
        case 'long-press':
            return new PointerEvent('contextmenu', { ...init, pointerType: 'touch', button: 0 });
    }
}

export const KEY_SOURCES = ['chrome-key', 'firefox-key', 'old-firefox-key'] as const;
export const POINTER_SOURCES = ['right-click', 'ctrl-click', 'long-press'] as const;
