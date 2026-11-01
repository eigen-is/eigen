import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';

const window = installHappyDom();

const { printDocument } = await import('../../lib/printElement');

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

let fonts = deferred();
let image = deferred();
// What each print saw: the clones on the page as it printed.
let printed: number[] = [];

beforeEach(() => {
    fonts = deferred();
    image = deferred();
    printed = [];
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: fonts.promise } });
    Object.defineProperty(window.HTMLImageElement.prototype, 'decode', {
        configurable: true,
        value: () => image.promise,
    });
    Object.assign(window, { print: () => printed.push(document.querySelectorAll('.printable').length) });
    document.body.innerHTML = '<div data-document><p>茶 tea 😀</p><img src="/cat.png"></div>';
});

afterEach(() => {
    document.body.innerHTML = '';
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A face is cut into unicode-range slices, and print draws a character whose slice is still loading in the fallback.
test('print waits for the fonts still loading, however long they take', async () => {
    image.resolve();
    printDocument();
    await wait(600);
    expect(printed).toEqual([]);

    fonts.resolve();
    await wait(0);
    expect(printed).toEqual([1]);
    expect(document.querySelectorAll('.printable').length).toBe(0);
});

test("print waits for the clone's images", async () => {
    fonts.resolve();
    printDocument();
    await wait(600);
    expect(printed).toEqual([]);

    image.resolve();
    await wait(0);
    expect(printed).toEqual([1]);
});

test('an image that fails to decode still prints', async () => {
    fonts.resolve();
    Object.defineProperty(window.HTMLImageElement.prototype, 'decode', {
        configurable: true,
        value: () => Promise.reject(new Error('broken image')),
    });
    printDocument();
    await wait(0);
    expect(printed).toEqual([1]);
});
