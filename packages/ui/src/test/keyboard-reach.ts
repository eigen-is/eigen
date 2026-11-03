// Where the keyboard reaches, and what a hover-revealed control looks like when no pointer is over it, as a browser
// with the app's stylesheet would draw it. happy-dom applies no CSS and moves no focus on Tab, so these read the
// Tailwind classes. `hidden` and `invisible` take an element and all it holds out of the tab order and the
// accessibility tree. `opacity-0` hides it from sight only, so a control under it is still a tab stop, and
// `pointer-events-none` keeps the pointer going through it. A focus variant may set either back. Any other
// `opacity-N` shows it, as `opacity-80` does.

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

// Who focused the element: Tab gives it `:focus-visible`, a mouse click gives it `:focus` alone.
type Focus = { on: Element; by: 'keyboard' | 'mouse' };

// The controls Tab visits under root, in order. The app uses no positive tabindex, so document order is it.
export function tabStops(root: ParentNode = document.body): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) =>
            element.tabIndex >= 0 &&
            !element.hasAttribute('disabled') &&
            element.closest('.hidden, .invisible, [hidden], [inert]') === null,
    );
}

// Whether element shows with no pointer over it, while focus is where the caller says or nowhere. A `pointer-coarse:`
// class never applies, since the test stands for a mouse.
export function isShown(element: Element, focus?: Focus): boolean {
    for (let node: Element | null = element; node; node = node.parentElement) {
        if (node.classList.contains('hidden')) return false;
        if (classValue(node, (utility) => utility === 'invisible' || utility === 'visible', focus) === 'invisible')
            return false;
        if (classValue(node, (utility) => /^opacity-\d+$/.test(utility), focus) === 'opacity-0') return false;
    }
    return true;
}

// Whether a click at element's spot lands on it with no pointer over it yet, which an invisible element never takes.
export function takesPointer(element: Element, focus?: Focus): boolean {
    if (element.closest('.hidden, .invisible')) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
        const value = classValue(
            node,
            (utility) => utility === 'pointer-events-none' || utility === 'pointer-events-auto',
            focus,
        );
        if (value) return value === 'pointer-events-auto';
    }
    return true;
}

// What a hover-revealed control does when no pointer is over it: at rest, after a mouse click put the focus on it and
// the pointer left, and when Tab reached it. The control may be hidden inside the one that takes the focus, as an icon
// in a button is. Compare it with HOVER_REVEALED.
export function revealStates(element: Element, focusable: Element = element) {
    const at = (focus?: Focus) => ({ shown: isShown(element, focus), takesPointer: takesPointer(element, focus) });
    return {
        tabStop: tabStops().some((stop) => stop === focusable),
        atRest: at(),
        afterMouseClick: at({ on: focusable, by: 'mouse' }),
        keyboardFocused: at({ on: focusable, by: 'keyboard' }),
    };
}

// A hover-revealed control a mouse user sees only on hover, and a keyboard user reaches and sees.
export const HOVER_REVEALED = {
    tabStop: true,
    atRest: { shown: false, takesPointer: false },
    afterMouseClick: { shown: false, takesPointer: false },
    keyboardFocused: { shown: true, takesPointer: true },
};

// Which of the utilities `isUtility` accepts the classes of node set in this focus state: the bare class, unless a
// focus variant that matches overrides it. Hover, pointer and other variants never match here.
function classValue(node: Element, isUtility: (utility: string) => boolean, focus?: Focus): string | undefined {
    let value: string | undefined;
    for (const token of node.classList) {
        const split = token.lastIndexOf(':') + 1;
        const utility = token.slice(split);
        if (!isUtility(utility)) continue;
        const variant = token.slice(0, split);
        if (variant === '') value ??= utility;
        else if (focus && variantMatches(variant, node, focus)) return utility;
    }
    return value;
}

function variantMatches(variant: string, node: Element, { on, by }: Focus): boolean {
    const keyboard = by === 'keyboard';
    // `.group:focus-within &` and `.group:has(*:focus-visible) &` match any `.group` above node, not only the nearest.
    // Focus-within counts the group's own focus, `:has(*:focus-visible)` only what it holds.
    const groups = ancestors(node).filter((ancestor) => ancestor.classList.contains('group'));
    const groupWithinFocus = groups.some((group) => group.contains(on));
    const groupHoldsFocus = groups.some((group) => group !== on && group.contains(on));
    switch (variant) {
        case 'focus:':
            return node === on;
        case 'focus-visible:':
            return keyboard && node === on;
        case 'focus-within:':
            return node.contains(on);
        case 'has-focus-visible:':
            return keyboard && node !== on && node.contains(on);
        case 'group-focus-within:':
            return groupWithinFocus;
        case 'group-has-focus-visible:':
            return keyboard && groupHoldsFocus;
        default:
            return false;
    }
}

function ancestors(node: Element): Element[] {
    const found: Element[] = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) found.push(parent);
    return found;
}
