// A keymap beside a detail column stands down while the focus is in the column, and comes back once it leaves.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement, Fragment } = await import('react');
const { useFocusInDetail } = await import('../../hooks/use-focus-in-detail');

let unmount = async () => {};
afterEach(() => unmount());

let focusInDetail: boolean | undefined;

function Probe() {
    focusInDetail = useFocusInDetail();
    return null;
}

test('true while the focus is in a detail column, false once it leaves', async () => {
    const rendered = await renderInDocument(
        createElement(
            Fragment,
            null,
            createElement(Probe),
            createElement('div', { 'data-slot': 'detail-column' }, createElement('button', { id: 'inside' })),
            createElement('button', { id: 'outside' }),
        ),
    );
    unmount = rendered.unmount;
    const button = (id: string) => {
        const found = document.getElementById(id);
        if (!(found instanceof HTMLButtonElement)) throw new Error(`no ${id}`);
        return found;
    };
    expect(focusInDetail).toBe(false);
    await act(async () => button('inside').focus());
    expect(focusInDetail).toBe(true);
    await act(async () => button('outside').focus());
    expect(focusInDetail).toBe(false);
});
