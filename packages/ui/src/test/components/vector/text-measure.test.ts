import { expect, test } from 'bun:test';
import { stubCanvasMeasure } from '../../canvas-measure';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

// A face cut into unicode-range slices loads only the slices its text needs. Called with the font alone, the font set
// tests a space, so the measurer must hand it the text it will measure.
const calls: [string, string | undefined][] = [];
Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
        check: (_font: string, text?: string) => {
            calls.push(['check', text]);
            return false;
        },
        load: async (_font: string, text?: string) => {
            calls.push(['load', text]);
            return [];
        },
    },
});

// Every character measures 10 px.
stubCanvasMeasure((line) => 10 * [...line].length);

const { isVectorFontLoaded, loadVectorFont, measureVectorText } = await import(
    '../../../components/vector/text-measure'
);

test('the font set loads and checks the slices of the text the label measures', async () => {
    calls.length = 0;
    const font = { fontSize: 20, fontFamily: 'sans' };
    isVectorFontLoaded('茶 tea 😀', font);
    await loadVectorFont('茶 tea 😀', font);
    expect(calls).toEqual([
        ['check', '茶 tea 😀'],
        ['load', '茶 tea 😀'],
    ]);
});

// A forged clipboard item can carry any letter spacing, and a large negative one would pull a line below zero width.
test('a line never measures narrower than nothing', () => {
    const { width } = measureVectorText('tea\nt', { fontSize: 20, fontFamily: 'sans', letterSpacing: -200 });
    expect(width).toBe(0);
});
