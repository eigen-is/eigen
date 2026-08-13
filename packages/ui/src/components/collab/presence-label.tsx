// Shared collaborator presence label. Docs' Tiptap caret is the reference visual;
// it needs a raw HTMLElement (`renderPresenceCaret`), while the sheet overlay needs
// JSX (`PresenceLabel`). Both render the same label chip classes so the two editors
// stay one source of truth — style lives in `.collaboration-cursor__label` (shared
// globals.css).

const PRESENCE_CARET_CLASS = 'collaboration-cursor__caret';
const PRESENCE_LABEL_CLASS = 'collaboration-cursor__label';

export type PresenceUser = {
    name: string;
    color: string;
};

// Builds the caret element Tiptap's CollaborationCaret.render expects: a vertical
// bar in the user's color with the name chip floating above it.
export function renderPresenceCaret(user: PresenceUser): HTMLElement {
    const cursor = document.createElement('span');
    cursor.classList.add(PRESENCE_CARET_CLASS);
    cursor.setAttribute('style', `border-color: ${user.color}`);

    const label = document.createElement('div');
    label.classList.add(PRESENCE_LABEL_CLASS);
    label.setAttribute('style', `background-color: ${user.color}`);
    label.insertBefore(document.createTextNode(user.name), null);

    // Word joiners (U+2060) keep the label from breaking the surrounding text run.
    cursor.insertBefore(document.createTextNode('⁠'), null);
    cursor.insertBefore(label, null);
    cursor.insertBefore(document.createTextNode('⁠'), null);

    return cursor;
}

// The name chip on its own, for editors that position their own selection box
// (the sheet overlay) rather than an inline caret.
export function PresenceLabel({ color, name }: { color: string; name: string }) {
    return (
        <div className={PRESENCE_LABEL_CLASS} style={{ backgroundColor: color }}>
            {name}
        </div>
    );
}
