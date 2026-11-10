// Whether the focus is in a field you type in: an input, a textarea or editable text. A hand-rolled document
// listener, such as a canvas's Space or clipboard handler, bails on it, so a shortcut never fires while the user
// types in, say, the comment composer beside a canvas. The hotkey library has its own gate.

export function isTypingTarget(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || (el instanceof HTMLElement && el.isContentEditable);
}
