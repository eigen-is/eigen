// The burst is one canvas over the page that clicks pass through, dropped while another runs and gone once it settles.
import { beforeEach, expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

const window = installHappyDom();

// happy-dom has no 2D context; the burst only needs one to draw into.
const context = new Proxy({}, { get: () => () => {}, set: () => true });
window.HTMLCanvasElement.prototype.getContext = (() => context) as never;

// Frames run when the test says, so a burst can be held mid-flight.
let frames: ((now: number) => void)[] = [];
globalThis.requestAnimationFrame = (callback: (now: number) => void) => frames.push(callback);
function runFrame(now: number) {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(now);
}

const { burstConfetti } = await import('../../../components/celebrate/confetti-burst');

beforeEach(() => {
    frames = [];
});

test('one canvas that clicks pass through, gone once the burst settles', () => {
    burstConfetti(new DOMRect(100, 200, 16, 16));
    const canvases = document.querySelectorAll('canvas');
    expect(canvases).toHaveLength(1);
    expect(canvases[0].style.pointerEvents).toBe('none');

    runFrame(1000);
    runFrame(1500);
    expect(document.querySelector('canvas')).not.toBeNull();
    runFrame(3000);
    expect(document.querySelector('canvas')).toBeNull();
    expect(frames).toHaveLength(0);
});

test('a second burst while one runs is dropped', () => {
    burstConfetti(new DOMRect(100, 200, 16, 16));
    burstConfetti(new DOMRect(300, 200, 16, 16));
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    runFrame(0);
    runFrame(5000);
    burstConfetti(new DOMRect(300, 200, 16, 16));
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
});
