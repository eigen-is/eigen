// Records each focus() call on an element with the options it got, since happy-dom draws no focus ring and ignores
// focusVisible. A mouse click focuses a button without a ring, which happy-dom can't tell from a Tab: withoutRing makes
// the element read as focused without one, as a browser's :focus-visible would.

export function recordFocus(element: HTMLElement, { withoutRing = false } = {}): (FocusOptions | undefined)[] {
    const calls: (FocusOptions | undefined)[] = [];
    const focus = element.focus.bind(element);
    element.focus = (options?: FocusOptions) => {
        calls.push(options);
        focus(options);
    };
    if (withoutRing) {
        const matches = element.matches.bind(element);
        Object.defineProperty(element, 'matches', {
            value: (selector: string) => selector !== ':focus-visible' && matches(selector),
        });
    }
    return calls;
}
