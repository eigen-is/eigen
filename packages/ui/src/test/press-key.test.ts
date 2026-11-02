// pressKey clicks only what a browser's Enter or Space would: an enabled button whose keydown no handler prevented.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from './happy-dom';
import { pressKey } from './press-key';

installHappyDom();

afterEach(() => {
    document.body.innerHTML = '';
});

function control(html: string) {
    document.body.innerHTML = html;
    const element = document.body.firstElementChild;
    if (!element) throw new Error('no control');
    const onClick = mock(() => {});
    element.addEventListener('click', onClick);
    return { element, onClick };
}

test('Enter and Space click a button', () => {
    const { element, onClick } = control('<button type="button">Open</button>');
    pressKey(element, 'Enter');
    pressKey(element, ' ');
    expect(onClick).toHaveBeenCalledTimes(2);
});

test('a div, a disabled button and a prevented keydown take no click', () => {
    for (const html of ['<div tabindex="0">Open</div>', '<button disabled>Open</button>']) {
        const { element, onClick } = control(html);
        pressKey(element, 'Enter');
        expect(onClick).not.toHaveBeenCalled();
    }
    const { element, onClick } = control('<button type="button">Open</button>');
    element.addEventListener('keydown', (event) => event.preventDefault());
    pressKey(element, ' ');
    expect(onClick).not.toHaveBeenCalled();
});
