// Expects a control to be hover-revealed the way HOVER_REVEAL_CLASS does it. happy-dom draws no CSS, so this reads
// the classes. `invisible` and `hidden` would take the control away from Tab, so it must hide under `opacity-0` in a
// `group`. Tab must show it too. A `focus-within:` reveal would keep it shown after a mouse click once the pointer left.

import { expect } from 'bun:test';

export function expectKeyboardReveal(control: Element): void {
    expect(control.closest('.invisible, .hidden')).toBeNull();
    const revealer = control.closest('.opacity-0');
    expect(revealer?.parentElement?.closest('.group')).toBeTruthy();
    const classes = revealer?.className ?? '';
    expect(classes).toMatch(/(^|[\s:])group-hover:opacity-\d+/);
    expect(classes).toMatch(/(^|\s)group-has-focus-visible:opacity-\d+/);
    expect(classes).not.toMatch(/(^|[\s:])(group-)?focus(-within)?:/);
}
