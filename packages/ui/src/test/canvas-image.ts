// What a downloaded image needs of the browser that a test has none of: Vite's font URLs, which bun has no glob for,
// and document.fonts, which happy-dom lacks. Each face's URL is /fonts/<file>, for the test's fetch to answer. Call
// it after installHappyDom.
import { afterAll, spyOn } from 'bun:test';
import * as bundled from '../components/vector/bundled-font-url';

export function stubCanvasImageFonts(): { takeFetched: () => string[] } {
    let files: string[] = [];
    const url = spyOn(bundled, 'bundledFontUrl').mockImplementation((file) => {
        files.push(file);
        return `/fonts/${file}`;
    });
    // A FontFaceSet is an event target too, which the sheet grid listens on for a face that finishes loading.
    const fontSet = Object.assign(new EventTarget(), { ready: Promise.resolve() });
    Object.defineProperty(document, 'fonts', { configurable: true, value: fontSet });
    afterAll(() => url.mockRestore());
    // The files asked for since the last take.
    const takeFetched = () => {
        const taken = files;
        files = [];
        return taken;
    };
    return { takeFetched };
}
