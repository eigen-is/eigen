import { expect, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import { getDocExtensions, PAGE_NUMBER_TEXT } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { PageNumber } from '../../../../components/docs/extensions/page-number';

installHappyDom();

const number = (kind: string) => ({ type: 'pageNumber', attrs: { kind } });

function editorWith(content: object[]) {
    return new Editor({
        element: document.createElement('div'),
        extensions: [...getDocExtensions({ exclude: ['pageNumber'] }), PageNumber],
        content: { type: 'doc', content: [{ type: 'paragraph', content }] },
    });
}

// Both kinds would show # alone, so the chip names its kind; the field's text stays #.
test('the chip names its kind on screen, in its tooltip and to a screen reader, and its text stays #', () => {
    const editor = editorWith([
        { type: 'text', text: 'Page ' },
        number('page'),
        { type: 'text', text: ' of ' },
        number('pages'),
    ]);
    const chips = [...editor.view.dom.querySelectorAll('[role="img"]')].map((chip) => [
        chip.textContent,
        chip.getAttribute('title'),
        chip.getAttribute('aria-label'),
    ]);
    expect(chips).toEqual([
        ['#page', 'Page number: shows the number when printed or downloaded as PDF or Word', 'Page number'],
        ['#pages', 'Page count: shows the number when printed or downloaded as PDF or Word', 'Page count'],
    ]);
    expect(editor.getText()).toBe(`Page ${PAGE_NUMBER_TEXT} of ${PAGE_NUMBER_TEXT}`);
    expect(editor.getHTML()).toContain(`data-kind="pages">${PAGE_NUMBER_TEXT}</span>`);
    editor.destroy();
});

// A browser's own print of the page, the offline fallback, shows the field as # as the HTML download does.
test("the kind's name hides in the browser's print", () => {
    const editor = editorWith([number('pages')]);
    const name = editor.view.dom.querySelector('[role="img"] > span');
    expect(name?.textContent).toBe('pages');
    expect(name?.className).toContain('print:hidden');
    editor.destroy();
});
