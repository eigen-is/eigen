// The color square of a dialog such as Edit label: a screen reader names it Color, a click opens the color grid, and a
// pick hands the color on and closes the grid.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { ColorPickerSwatch } = await import('../../../components/media/color-picker-swatch');

let unmount = async () => {};
afterEach(() => unmount());

const click = (target: HTMLElement | null | undefined) =>
    act(async () => {
        if (!target) throw new Error('nothing to click');
        target.click();
    });
const swatches = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button[title]')];

test('the swatch is named Color, and a pick hands the color on and closes the grid', async () => {
    const onChange = mock((_color: string) => {});
    ({ unmount } = await renderInDocument(createElement(ColorPickerSwatch, { value: '#3b82f6', onChange })));
    const swatch = document.querySelector<HTMLButtonElement>('button[aria-label="Color"]');
    expect(swatch?.style.backgroundColor).toBeTruthy();

    await click(swatch);
    // The grid's first row runs from black to white, and each grey's title is its value.
    await click(swatches().find((b) => b.title === '#000000'));
    expect(onChange.mock.calls).toEqual([['#000000']]);
    expect(swatches()).toEqual([]);
});
