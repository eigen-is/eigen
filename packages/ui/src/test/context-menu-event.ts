// A contextmenu event as each browser sends it, for the code that tells a key's from a pointer's. A key's reports no
// button, which reads as 0: Chrome with the mouse's pointerType, Firefox with an empty one, and Firefox before 129 as a
// plain MouseEvent. A right-click reports button 2. A Mac's Ctrl+click in Firefox and a long press in Chrome report 0.
// A long press in Firefox for Android before 129 is a plain MouseEvent with button 0 as well, so only its target, the
// row under the finger rather than the element with the focus, tells it from a key's.

export type ContextMenuSource =
    | 'chrome-key'
    | 'firefox-key'
    | 'old-firefox-key'
    | 'right-click'
    | 'ctrl-click'
    | 'long-press'
    | 'old-firefox-long-press';

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
        case 'old-firefox-long-press':
            return new MouseEvent('contextmenu', { ...init, button: 0 });
    }
}

export const KEY_SOURCES = ['chrome-key', 'firefox-key', 'old-firefox-key'] as const;
export const POINTER_SOURCES = ['right-click', 'ctrl-click', 'long-press'] as const;
