// What a downloaded image needs of the browser that a test has none of: Vite's font URLs, which bun has no glob for.
// Each face's URL is /fonts/<file>, for the test's fetch to answer. Call it after installHappyDom, which gives the
// test its document.fonts.
import { afterAll, spyOn } from 'bun:test';
import * as bundled from '../components/vector/bundled-font-url';

export function stubCanvasImageFonts(): { takeFetched: () => string[] } {
    let files: string[] = [];
    const url = spyOn(bundled, 'bundledFontUrl').mockImplementation((file) => {
        files.push(file);
        return `/fonts/${file}`;
    });
    afterAll(() => url.mockRestore());
    // The files asked for since the last take.
    const takeFetched = () => {
        const taken = files;
        files = [];
        return taken;
    };
    return { takeFetched };
}
