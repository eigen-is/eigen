// Is the focused element a text-entry target (input / textarea / contentEditable)? The shared
// gate every document-level keymap and copy/paste handler bails on, so a canvas shortcut never
// fires while the user is typing — the comments composer inside a canvas editor is the case that
// breaks first if this slips. The hotkey lib has its own input gate; this is for hand-rolled
// listeners (canvas Space/Escape, slides clipboard handlers, vector z-order brackets).
export function isTypingTarget(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
}
