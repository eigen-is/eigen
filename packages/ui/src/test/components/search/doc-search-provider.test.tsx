// The find bar tells its host when it opens or closes, once per change, even when the host hands in a new callback
// on every render, as the comments column does.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { DocSearchProvider, useOptionalDocSearchBar } = await import('../../../components/search/doc-search-provider');

let unmount = async () => {};
afterEach(() => unmount());

const controller = { search: () => [], highlightAll: () => {}, reveal: () => {} };

test('a host with a new callback each render hears each open change once', async () => {
    const calls: boolean[] = [];
    let rerender = () => {};
    let openBar = () => {};
    function Grab() {
        const bar = useOptionalDocSearchBar();
        if (bar) openBar = bar.open;
        return null;
    }
    function Host() {
        const [, setTick] = useState(0);
        rerender = () => setTick((t) => t + 1);
        return createElement(DocSearchProvider, {
            controller,
            onOpenChange: (open: boolean) => {
                calls.push(open);
            },
            children: createElement(Grab),
        });
    }
    ({ unmount } = await renderInDocument(createElement(Host)));
    await act(async () => openBar());
    for (let i = 0; i < 3; i++) await act(async () => rerender());
    expect(calls).toEqual([false, true]);
});
