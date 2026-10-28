// Page setup is Google Docs' Pages and Page-less tabs: on Pages, orientation, paper size and margins in centimetres; on
// Page-less, the reader's own text width. A writer changes the doc's page and format with OK; a viewer reads them and
// sets only their own text width. A band's Header format… and Footer format… open Google's Headers & footers
// dialog: the bands' distances from the paper's edge, in centimetres, and Different first page, applied with Apply.
import { afterEach, expect, mock, test } from 'bun:test';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import type { DocsTextWidth } from '@workspace/lib/types/settings';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const Y = await import('yjs');
const { DEFAULT_PAGE_SETUP, PAGE_ROOT, PAPER_SIZES, pageRecord, readPageSetup } = await import(
    '@workspace/lib/docs/eigendoc'
);
const { HeadersAndFootersDialog, PageSetupDialog } = await import('../../../components/docs/page-setup-dialog');
const { createDocUndoManager, writePageSetup } = await import('../../../components/docs/page-setup');

function control(label: string): HTMLElement | null {
    const element = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    return element ? document.getElementById(element.htmlFor) : null;
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label);
// Radix portals the open list to the body.
const options = () =>
    [...document.querySelectorAll('[data-slot="select-content"] [role="option"]')].map((option) => ({
        label: option.textContent?.trim(),
        disabled: option.hasAttribute('data-disabled'),
    }));

const click = (element: Element | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to click');
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

async function type(label: string, value: string) {
    const input = control(label);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no ${label} field`);
    // React reads the value off its own tracker, so the native setter is what a keystroke looks like.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
}

const margins = () =>
    ['Top', 'Bottom', 'Left', 'Right'].map((side) => {
        const input = control(side);
        return input instanceof HTMLInputElement ? input.value : null;
    });

let unmount = async () => {};
afterEach(() => unmount());

const onOpenChange = mock((_open: boolean) => {});
const onSetupChange = mock((_from: PageSetup, _to: PageSetup) => {});
const onTextWidthChange = mock((_width: DocsTextWidth) => {});

async function render(setup: PageSetup = DEFAULT_PAGE_SETUP, canWrite = true, textWidth: DocsTextWidth = 'narrow') {
    onOpenChange.mockClear();
    onSetupChange.mockClear();
    onTextWidthChange.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(PageSetupDialog, {
            open: true,
            onOpenChange,
            setup,
            canWrite,
            onSetupChange,
            textWidth,
            onTextWidthChange,
        }),
    ));
}

const tab = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find((t) => t.textContent === label);
const widths = () =>
    ['Narrow', 'Medium', 'Wide', 'Full'].map((label) => control(label)?.getAttribute('aria-checked') ?? null);
// Radix Tabs switches on a mousedown, as a keyboard user's focus would.
const pickTab = (label: string) =>
    act(async () => {
        tab(label)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });

test("a writer sees the doc's page in Google's controls, all of them enabled", async () => {
    await render();

    expect(control('Portrait')?.getAttribute('aria-checked')).toBe('true');
    expect(control('Landscape')?.getAttribute('aria-checked')).toBe('false');
    expect(control('Paper size')?.textContent).toBe('A4 (21.0 cm × 29.7 cm)');
    expect(margins()).toEqual(['2.00', '2.00', '2.00', '2.00']);

    const controls = document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        '[role="dialog"] [role="radio"], [role="dialog"] [role="combobox"], [role="dialog"] input:not([aria-hidden])',
    );
    expect(controls.length).toBe(7);
    for (const element of controls) expect(element.disabled).toBe(false);
    expect(button('Close')).toBeUndefined();
    expect(dialog()?.textContent).toContain('Margins (centimetres)');
});

test('a cm field shows two decimals, as its step, but keeps what is typed until it is left', async () => {
    await render();
    const top = control('Top');
    if (!(top instanceof HTMLInputElement)) throw new Error('no Top field');
    expect(top.step).toBe('0.01');
    await type('Top', '2.5');
    expect(top.value).toBe('2.5');
    await act(async () => top.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(top.value).toBe('2.50');
});

test("the paper sizes are Google's eleven, with no Custom entry for a standard page", async () => {
    await render();
    await click(control('Paper size'));
    expect(options().map(({ label }) => label)).toEqual([
        'Letter (21.6 cm × 27.9 cm)',
        'Tabloid (27.9 cm × 43.2 cm)',
        'Legal (21.6 cm × 35.6 cm)',
        'Statement (14.0 cm × 21.6 cm)',
        'Executive (18.4 cm × 26.7 cm)',
        'Folio (21.6 cm × 33.0 cm)',
        'A3 (29.7 cm × 42.0 cm)',
        'A4 (21.0 cm × 29.7 cm)',
        'A5 (14.8 cm × 21.0 cm)',
        'B4 (25.0 cm × 35.3 cm)',
        'B5 (17.6 cm × 25.0 cm)',
    ]);
});

test('a page of no standard size shows as a Custom entry nobody can pick', async () => {
    await render({ ...DEFAULT_PAGE_SETUP, width: 148, height: 105 });
    expect(control('Paper size')?.textContent).toBe('Custom (10.5 cm × 14.8 cm)');
    expect(control('Landscape')?.getAttribute('aria-checked')).toBe('true');
    await click(control('Paper size'));
    expect(options().at(-1)).toEqual({ label: 'Custom (10.5 cm × 14.8 cm)', disabled: true });
});

test('Landscape turns the paper, and a size picked then keeps the orientation', async () => {
    await render();
    await click(control('Landscape'));
    await click(control('Paper size'));
    await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith('Letter')));
    expect(control('Paper size')?.textContent).toBe('Letter (21.6 cm × 27.9 cm)');
    await type('Top', '2.54');
    await click(button('OK'));

    expect(onSetupChange.mock.calls).toEqual([
        [
            DEFAULT_PAGE_SETUP,
            {
                width: 279.4,
                height: 215.9,
                margin: { top: 25.4, right: 20, bottom: 20, left: 20 },
                headerDistance: 12.7,
                footerDistance: 12.7,
                differentFirstPage: false,
                pageless: false,
            },
        ],
    ]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('an untouched margin keeps its exact size, though the field rounds it', async () => {
    const setup = { ...DEFAULT_PAGE_SETUP, margin: { top: 19.05, right: 168.18181, bottom: 20, left: 20 } };
    await render(setup);
    expect(margins()).toEqual(['1.91', '2.00', '2.00', '16.82']);
    await click(control('Landscape'));
    await click(button('OK'));
    expect(onSetupChange.mock.calls).toEqual([[setup, { ...setup, width: 297, height: 210 }]]);
});

test('a typed margin is stored to the hundredth of a millimetre', async () => {
    await render();
    await type('Top', '1.91');
    await type('Left', '2.54');
    await click(button('OK'));
    expect(onSetupChange.mock.calls[0]?.[1].margin).toEqual({ top: 19.1, right: 20, bottom: 20, left: 25.4 });
});

test('any page the doc reads opens with OK enabled, its margins shrunk or not', async () => {
    for (const { width } of PAPER_SIZES) {
        for (const [marginLeft, marginRight] of [
            [40.9, 151.3],
            [200, 0.1],
            [0.1, 200],
            [1e9, 19.05],
            [12.7, 0],
        ]) {
            await render(readPageSetup({ width, marginLeft, marginRight }));
            expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
            expect(button('OK')?.disabled).toBe(false);
            await unmount();
        }
    }
});

test("OK leaves a collaborator's change to a field the user didn't touch", async () => {
    const opened: PageSetup = {
        ...DEFAULT_PAGE_SETUP,
        width: 215.9,
        height: 279.4,
        margin: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
    };
    const doc = new Y.Doc();
    for (const [key, value] of Object.entries(pageRecord(opened))) doc.getMap(PAGE_ROOT).set(key, value);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    await render(readPageSetup(doc.getMap(PAGE_ROOT).toJSON()));

    peer.getMap(PAGE_ROOT).set('marginTop', 30);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    await click(control('Landscape'));
    await click(button('OK'));
    const [[from, to] = []] = onSetupChange.mock.calls;
    if (!from || !to) throw new Error('OK wrote nothing');
    writePageSetup(doc, createDocUndoManager(doc), from, to);

    expect(readPageSetup(doc.getMap(PAGE_ROOT).toJSON())).toEqual({
        ...opened,
        width: 279.4,
        height: 215.9,
        margin: { ...opened.margin, top: 30 },
    });
});

test('OK stores the margins the dialog showed for a page whose stored margins read back shrunk', async () => {
    const doc = new Y.Doc();
    const page = doc.getMap(PAGE_ROOT);
    page.set('marginLeft', 200);
    page.set('marginRight', 200);
    await render(readPageSetup(page.toJSON()));
    expect(margins()).toEqual(['2.00', '2.00', '9.25', '9.25']);

    await click(control('Paper size'));
    await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith('A3')));
    await click(button('OK'));
    const [[from, to] = []] = onSetupChange.mock.calls;
    if (!from || !to) throw new Error('OK wrote nothing');
    writePageSetup(doc, createDocUndoManager(doc), from, to);

    expect(page.toJSON()).toEqual({ width: 297, height: 420, marginLeft: 92.5, marginRight: 92.5 });
});

test.each([
    ['a 20 cm top margin on A5', { ...DEFAULT_PAGE_SETUP, width: 148, height: 210 }, 'Top', '20'],
    ['a negative margin', DEFAULT_PAGE_SETUP, 'Left', '-1'],
    ['an empty margin', DEFAULT_PAGE_SETUP, 'Right', ''],
])('%s shows an error and OK does nothing', async (_, setup, side, value) => {
    await render(setup);
    await type(side, value);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
        'Margins must be 0 cm or more and leave at least 2.5 cm for the text.',
    );
    expect(button('OK')?.disabled).toBe(true);
    await click(button('OK'));
    expect(onSetupChange).not.toHaveBeenCalled();
});

test('Cancel closes without a change', async () => {
    await render();
    await type('Top', '3');
    await click(button('Cancel'));
    expect(onSetupChange).not.toHaveBeenCalled();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a viewer sees the page read-only, with one Close button', async () => {
    await render({ ...DEFAULT_PAGE_SETUP, width: 297, height: 210 }, false);

    expect(control('Landscape')?.getAttribute('aria-checked')).toBe('true');
    expect(control('Paper size')?.textContent).toBe('A4 (21.0 cm × 29.7 cm)');
    const controls = document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        '[role="dialog"] [role="radio"], [role="dialog"] [role="combobox"], [role="dialog"] input:not([aria-hidden])',
    );
    expect(controls.length).toBe(7);
    for (const element of controls) expect(element.disabled).toBe(true);

    expect(button('OK')).toBeUndefined();
    expect(button('Cancel')).toBeUndefined();
    await click(button('Close'));
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a writer turns the doc page-less on its tab, which shows no paper or margins, and OK writes it', async () => {
    await render();
    expect(tab('Pages')?.getAttribute('aria-selected')).toBe('true');
    await pickTab('Page-less');

    expect(control('Paper size')).toBeNull();
    expect(control('Top')).toBeNull();
    expect(dialog()?.textContent).toContain('everyone who opens it sees the one chosen here');
    expect(dialog()?.textContent).toContain('Your own view');
    expect(widths()).toEqual(['true', 'false', 'false', 'false']);
    await click(button('OK'));

    expect(onSetupChange.mock.calls).toEqual([[DEFAULT_PAGE_SETUP, { ...DEFAULT_PAGE_SETUP, pageless: true }]]);
    expect(onTextWidthChange.mock.calls).toEqual([]);
});

test("a page-less doc opens on its tab, and OK saves a new text width as the reader's, apart from the doc", async () => {
    const setup = { ...DEFAULT_PAGE_SETUP, pageless: true };
    await render(setup, true, 'medium');
    expect(tab('Page-less')?.getAttribute('aria-selected')).toBe('true');
    expect(widths()).toEqual(['false', 'true', 'false', 'false']);
    await click(control('Full'));
    await click(button('OK'));

    expect(onTextWidthChange.mock.calls).toEqual([['full']]);
    // The doc's page is handed over unchanged, which writePageSetup writes as nothing.
    expect(onSetupChange.mock.calls).toEqual([[setup, setup]]);
});

test('Pages switches a page-less doc back, its paper and margins as they were', async () => {
    const setup = { ...DEFAULT_PAGE_SETUP, width: 297, height: 210, pageless: true };
    await render(setup);
    await pickTab('Pages');
    expect(control('Landscape')?.getAttribute('aria-checked')).toBe('true');
    await click(button('OK'));
    expect(onSetupChange.mock.calls).toEqual([[setup, { ...setup, pageless: false }]]);
});

test("a viewer of a page-less doc can't switch it to pages, but sets their own text width", async () => {
    await render({ ...DEFAULT_PAGE_SETUP, pageless: true }, false);
    expect(tab('Pages')?.disabled).toBe(true);
    await click(control('Wide'));
    await click(button('OK'));
    expect(onTextWidthChange.mock.calls).toEqual([['wide']]);
    expect(onSetupChange.mock.calls).toEqual([]);
});

test('a phone gets no text width, as its column is the screen', async () => {
    onOpenChange.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(PageSetupDialog, {
            open: true,
            onOpenChange,
            setup: { ...DEFAULT_PAGE_SETUP, pageless: true },
            canWrite: true,
            onSetupChange,
        }),
    ));
    expect(dialog()?.textContent).toContain('one continuous column');
    expect(control('Narrow')).toBeNull();
});

async function renderBandFormat(setup: PageSetup = DEFAULT_PAGE_SETUP) {
    onOpenChange.mockClear();
    onSetupChange.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(HeadersAndFootersDialog, { open: true, onOpenChange, setup, onSetupChange }),
    ));
}

const distances = () =>
    ['Header (centimetres from top)', 'Footer (centimetres from bottom)'].map((label) => {
        const input = control(label);
        return input instanceof HTMLInputElement ? input.value : null;
    });

test('Headers and footers shows the distances from the edge in centimetres, and Different first page', async () => {
    await renderBandFormat({ ...DEFAULT_PAGE_SETUP, headerDistance: 9.5, differentFirstPage: true });
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Headers and footers');
    expect(dialog()?.querySelector('legend')?.textContent).toBe('Margins');
    expect(distances()).toEqual(['0.95', '1.27']);
    expect(control('Different first page')?.getAttribute('aria-checked')).toBe('true');
});

test('Apply writes the distances and Different first page; an untouched distance keeps its exact size', async () => {
    const setup = { ...DEFAULT_PAGE_SETUP, footerDistance: 12.345 };
    await renderBandFormat(setup);
    await type('Header (centimetres from top)', '1');
    await click(control('Different first page'));
    await click(button('Apply'));
    expect(onSetupChange.mock.calls).toEqual([[setup, { ...setup, headerDistance: 10, differentFirstPage: true }]]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test.each([
    ['a header past its 2 cm margin', 'Header (centimetres from top)', '2.5'],
    ['a negative footer distance', 'Footer (centimetres from bottom)', '-1'],
    ['an empty distance', 'Header (centimetres from top)', ''],
])('%s shows an error and Apply does nothing', async (_, label, value) => {
    await renderBandFormat();
    await type(label, value);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
        'The header must be 0 to 2 cm from the top and the footer 0 to 2 cm from the bottom, within their margins.',
    );
    expect(button('Apply')?.disabled).toBe(true);
    await click(button('Apply'));
    expect(onSetupChange).not.toHaveBeenCalled();
});

test('Headers and footers writes through the page map, as one undo step', async () => {
    const doc = new Y.Doc();
    const undoManager = createDocUndoManager(doc);
    await renderBandFormat(readPageSetup(doc.getMap(PAGE_ROOT).toJSON()));
    await type('Footer (centimetres from bottom)', '0.8');
    await click(button('Apply'));
    const [[from, to] = []] = onSetupChange.mock.calls;
    if (!from || !to) throw new Error('OK wrote nothing');
    writePageSetup(doc, undoManager, from, to);
    expect(doc.getMap(PAGE_ROOT).toJSON()).toEqual({ footerDistance: 8 });

    undoManager.undo();
    expect(doc.getMap(PAGE_ROOT).toJSON()).toEqual({});
});
