// A press only closes a menu while the menu is open. A menu a pick just closed stays in the document for the length
// of its exit animation, and a press in that time is the user's next action.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';

installHappyDom();

const { pressClosesMenu } = await import('../../components/menubar');

afterEach(() => {
    document.body.innerHTML = '';
});

function menu(state: 'open' | 'closed') {
    const el = document.createElement('div');
    el.setAttribute('role', 'menu');
    el.setAttribute('data-state', state);
    document.body.append(el);
}

test('an open menu makes the press a close', () => {
    menu('open');
    expect(pressClosesMenu()).toBe(true);
});

test('a menu fading out does not', () => {
    menu('closed');
    expect(pressClosesMenu()).toBe(false);
});

test('no menu does not', () => {
    expect(pressClosesMenu()).toBe(false);
});
