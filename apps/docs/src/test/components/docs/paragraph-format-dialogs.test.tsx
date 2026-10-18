// Google Docs' Custom spacing (line spacing, and before and after in points) and Indentation options (left and right in
// centimetres, a first line or hanging indent): each opens on what the selection's first paragraph draws, and Apply
// writes only the fields that changed, to every paragraph selected.
import { afterEach, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions, PARAGRAPH_FORMAT_KEYS } = await import('@workspace/lib/docs/eigendoc');
const { CustomSpacingDialog } = await import('../../../components/docs/custom-spacing-dialog');
const { IndentationOptionsDialog } = await import('../../../components/docs/indentation-options-dialog');

let unmount = async () => {};
afterEach(() => unmount());

const editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: getDocExtensions(),
});

const paragraphs = (...attrs: Record<string, unknown>[]): JSONContent => ({
    type: 'doc',
    content: attrs.map((format) => ({ type: 'paragraph', attrs: format, content: [{ type: 'text', text: 'ab' }] })),
});

// Each paragraph's stored format, unset keys left out.
const formats = () =>
    (editor.getJSON().content ?? []).map((block) =>
        Object.fromEntries(
            PARAGRAPH_FORMAT_KEYS.flatMap((key) => (block.attrs?.[key] == null ? [] : [[key, block.attrs[key]]])),
        ),
    );

function control(label: string): HTMLElement | null {
    const element = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    return element ? document.getElementById(element.htmlFor) : null;
}

const value = (label: string) => {
    const input = control(label);
    return input instanceof HTMLInputElement ? input.value : input?.textContent;
};

async function type(label: string, text: string) {
    const input = control(label);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no ${label} field`);
    // React reads the value off its own tracker, so the native setter is what a keystroke looks like.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
}

const click = (element: Element | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to click');
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === label);

async function apply() {
    await act(async () => button('Apply')?.click());
}

async function open(dialog: typeof CustomSpacingDialog, content: JSONContent, from = 1, to = from) {
    editor.commands.setContent(content);
    editor.commands.setTextSelection({ from, to });
    ({ unmount } = await renderInDocument(createElement(dialog, { editor, open: true, onOpenChange: () => {} })));
}

test("Custom spacing opens on Eigen's look for an unset paragraph, and an untouched field writes nothing", async () => {
    await open(CustomSpacingDialog, paragraphs({}));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Custom spacing');
    expect(['Line spacing', 'Before', 'After'].map(value)).toEqual(['1.4', '0', '11']);
    await type('Before', '6');
    await apply();
    expect(formats()).toEqual([{ spaceBefore: 6 }]);
});

test('Custom spacing writes every selected paragraph, from what the first one draws', async () => {
    await open(CustomSpacingDialog, paragraphs({ lineSpacing: 1.15, spaceAfter: 4 }, {}), 1, 6);
    expect(['Line spacing', 'Before', 'After'].map(value)).toEqual(['1.15', '0', '4']);
    await type('Line spacing', '2');
    await apply();
    expect(formats()).toEqual([{ lineSpacing: 2, spaceAfter: 4 }, { lineSpacing: 2 }]);
});

// A list, a quote and a table cell own the spacing of what they hold.
test("in a list item Custom spacing sets the line spacing, and Before and After are the list's", async () => {
    const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'ab' }] };
    await open(
        CustomSpacingDialog,
        { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph] }] }] },
        3,
    );
    expect(['Before', 'After'].map((label) => control(label)?.hasAttribute('disabled'))).toEqual([true, true]);
    expect(['Before', 'After'].map(value)).toEqual(['0', '0']);
    await type('Line spacing', '2');
    await apply();
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs).toMatchObject({
        lineSpacing: 2,
        spaceBefore: null,
        spaceAfter: null,
    });
});

test('Custom spacing refuses a line spacing or a spacing out of range', async () => {
    await open(CustomSpacingDialog, paragraphs({}));
    await type('Line spacing', '9');
    expect(button('Apply')?.disabled).toBe(true);
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
        'Line spacing must be between 0.5 and 5, and spacing between 0 and 400 points.',
    );
    await type('Line spacing', '1.5');
    await type('After', '-1');
    expect(button('Apply')?.disabled).toBe(true);
    await type('After', '');
    expect(button('Apply')?.disabled).toBe(true);
});

// Google's and Word's Left is where the body lines stand, and a hanging first line starts left of it.
test('Indentation options opens on no indent in centimetres, and Left with a hanging indent sets the body lines', async () => {
    await open(IndentationOptionsDialog, paragraphs({}));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Indentation options');
    expect(['Left', 'Right', 'Special indent'].map(value)).toEqual(['0', '0', 'None']);
    const by = control('By');
    expect(by instanceof HTMLInputElement && by.disabled).toBe(true);
    await type('Left', '2');
    await click(control('Special indent'));
    await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Hanging'));
    await type('By', '1');
    await apply();
    // The body lines at 2 cm, the first line 1 cm left of them: w:left 1134 and w:hanging 567 in the docx.
    expect(formats()).toEqual([{ indentLeft: 56.7, indentFirstLine: -28.35 }]);
});

test('Indentation options shows a stored indent as Google does, and writes only what changed', async () => {
    await open(IndentationOptionsDialog, paragraphs({ indentLeft: 72, indentFirstLine: -36, indentRight: 18.05 }));
    expect(['Left', 'Right', 'Special indent', 'By'].map(value)).toEqual(['2.54', '0.64', 'Hanging', '1.27']);
    await type('By', '2.54');
    await apply();
    // Left stays where the body lines are, so only the first line moves.
    expect(formats()).toEqual([{ indentLeft: 72, indentFirstLine: -72, indentRight: 18.05 }]);
});

test('Indentation options: a first line indent, and None takes it away', async () => {
    await open(IndentationOptionsDialog, paragraphs({ indentFirstLine: 18 }));
    expect(['Special indent', 'By'].map(value)).toEqual(['First line', '0.64']);
    await click(control('Special indent'));
    await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'None'));
    await apply();
    expect(formats()).toEqual([{}]);
});

test('Indentation options refuses a negative indent', async () => {
    await open(IndentationOptionsDialog, paragraphs({}));
    await type('Left', '-1');
    expect(button('Apply')?.disabled).toBe(true);
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Indents must be 0 cm or more.');
});
