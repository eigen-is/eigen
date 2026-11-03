// tabStops, isShown and takesPointer read the Tailwind classes a browser would apply: `invisible` and `hidden` take a
// control out of the tab order, `opacity-0` hides it from sight and `pointer-events-none` from the pointer, until a
// focus variant that matches who focused it sets them back.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from './happy-dom';
import { isShown, tabStops, takesPointer } from './keyboard-reach';

installHappyDom();

afterEach(() => {
    document.body.innerHTML = '';
});

function button(html: string): HTMLButtonElement {
    document.body.innerHTML = html;
    const found = document.querySelector('button');
    if (!found) throw new Error('no button');
    return found;
}

test('a button under invisible or hidden is no tab stop, takes no click and never shows', () => {
    for (const hiding of ['invisible', 'hidden']) {
        const hidden = button(
            `<div class="group"><div class="${hiding} group-hover:visible"><button>x</button></div></div>`,
        );
        expect(tabStops()).not.toContain(hidden);
        expect(isShown(hidden)).toBe(false);
        expect(takesPointer(hidden)).toBe(false);
    }
});

test('a disabled button, one with tabindex -1 and one in an inert subtree are no tab stops', () => {
    document.body.innerHTML =
        '<button disabled>a</button><button tabindex="-1">b</button><div inert><button>c</button></div><button>d</button>';
    expect(tabStops().map((stop) => stop.textContent)).toEqual(['d']);
});

test('a button under opacity-0 is a tab stop, and shows on focus only with a focus variant', () => {
    const hoverOnly = button(
        '<div class="group"><div class="opacity-0 group-hover:opacity-100"><button>x</button></div></div>',
    );
    expect(tabStops()).toContain(hoverOnly);
    expect(isShown(hoverOnly, { on: hoverOnly, by: 'keyboard' })).toBe(false);

    const ownFocus = button('<button class="opacity-0 focus-visible:opacity-100">x</button>');
    expect(isShown(ownFocus)).toBe(false);
    expect(isShown(ownFocus, { on: ownFocus, by: 'keyboard' })).toBe(true);
    expect(isShown(ownFocus, { on: ownFocus, by: 'mouse' })).toBe(false);
});

test('any opacity above 0 shows, and a focus variant may set a partial opacity', () => {
    expect(isShown(button('<button class="opacity-80">x</button>'))).toBe(true);
    const partial = button(
        '<div class="group"><div class="opacity-0 group-has-focus-visible:opacity-80"><button>x</button></div></div>',
    );
    expect(isShown(partial)).toBe(false);
    expect(isShown(partial, { on: partial, by: 'keyboard' })).toBe(true);
});

test('group-has-focus-visible shows for the keyboard only, and group-focus-within for a mouse click too', () => {
    const keyboardOnly = button(
        '<div class="group"><div class="opacity-0 group-has-focus-visible:opacity-100"><button>x</button></div></div>',
    );
    expect(isShown(keyboardOnly, { on: keyboardOnly, by: 'keyboard' })).toBe(true);
    expect(isShown(keyboardOnly, { on: keyboardOnly, by: 'mouse' })).toBe(false);

    const anyFocus = button(
        '<div class="group"><div class="opacity-0 group-focus-within:opacity-100"><button>x</button></div></div>',
    );
    expect(isShown(anyFocus, { on: anyFocus, by: 'mouse' })).toBe(true);
});

test('a group variant needs a group above it', () => {
    const noGroup = button('<div class="opacity-0 group-has-focus-visible:opacity-100"><button>x</button></div>');
    expect(isShown(noGroup, { on: noGroup, by: 'keyboard' })).toBe(false);
});

test('pointer-events-none keeps the click off the button until a matching variant sets it back', () => {
    const gated = button(
        '<div class="group"><div class="pointer-events-none group-has-focus-visible:pointer-events-auto"><button>x</button></div></div>',
    );
    expect(takesPointer(gated)).toBe(false);
    expect(takesPointer(gated, { on: gated, by: 'mouse' })).toBe(false);
    expect(takesPointer(gated, { on: gated, by: 'keyboard' })).toBe(true);
    expect(takesPointer(button('<div class="opacity-0"><button>x</button></div>'))).toBe(true);
});

test('a group variant matches any group above the button, not only the nearest', () => {
    button(
        '<div class="group"><div class="group"><div class="opacity-0 group-has-focus-visible:opacity-100"><button>x</button></div></div></div>',
    );
    const outer = document.querySelector('.group');
    const reveal = document.querySelector('.opacity-0');
    if (!outer || !reveal) throw new Error('no groups');
    // Focus sits beside the revealed control: in the outer group, outside the inner one.
    outer.insertAdjacentHTML('beforeend', '<input class="other">');
    const other = document.querySelector('.other');
    if (!other) throw new Error('no input');
    expect(isShown(reveal, { on: other, by: 'keyboard' })).toBe(true);
    expect(isShown(reveal, { on: other, by: 'mouse' })).toBe(false);
});

test('group-has-focus-visible leaves the group itself out, and group-focus-within counts it', () => {
    document.body.innerHTML =
        '<div class="group"><div id="a" class="opacity-0 group-has-focus-visible:opacity-100"></div></div><div class="group"><div id="b" class="opacity-0 group-focus-within:opacity-100"></div></div>';
    const [groupA, groupB] = document.querySelectorAll('.group');
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    if (!groupA || !groupB || !a || !b) throw new Error('no group');
    expect(isShown(a, { on: groupA, by: 'keyboard' })).toBe(false);
    expect(isShown(b, { on: groupB, by: 'keyboard' })).toBe(true);
});
