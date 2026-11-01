import { expect, test } from 'bun:test';
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

const { isVectorFontLoaded, loadVectorFont } = await import('../../../components/vector/text-measure');

test('the font set loads and checks the slices of the text the label measures', async () => {
    calls.length = 0;
    isVectorFontLoaded(20, 'sans', '茶 tea 😀');
    await loadVectorFont(20, 'sans', '茶 tea 😀');
    expect(calls).toEqual([
        ['check', '茶 tea 😀'],
        ['load', '茶 tea 😀'],
    ]);
});
