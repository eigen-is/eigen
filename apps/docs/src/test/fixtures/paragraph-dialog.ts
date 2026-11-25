// What the paragraph format dialogs' tests share, such as Custom spacing's and Indentation options': a doc of formatted
// paragraphs, each paragraph's stored format read back, and the dialog's fields found by their label and typed into as
// a person does. Call after happy-dom is installed: React and the editor load only then.

import type { Editor, JSONContent } from '@tiptap/core';

export const paragraphs = (...attrs: Record<string, unknown>[]): JSONContent => ({
    type: 'doc',
    content: attrs.map((format) => ({ type: 'paragraph', attrs: format, content: [{ type: 'text', text: 'ab' }] })),
});

// Each paragraph's stored format, unset keys left out.
export async function formats(editor: Editor) {
    const { PARAGRAPH_FORMAT_KEYS } = await import('@workspace/lib/docs/eigendoc');
    return (editor.getJSON().content ?? []).map((block) =>
        Object.fromEntries(
            PARAGRAPH_FORMAT_KEYS.flatMap((key) => (block.attrs?.[key] == null ? [] : [[key, block.attrs[key]]])),
        ),
    );
}

export function control(label: string): HTMLElement | null {
    const element = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    return element ? document.getElementById(element.htmlFor) : null;
}

export const value = (label: string) => {
    const input = control(label);
    return input instanceof HTMLInputElement ? input.value : input?.textContent;
};

export async function type(label: string, text: string) {
    const { act } = await import('react');
    const input = control(label);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no ${label} field`);
    // React reads the value off its own tracker, so the native setter is what a keystroke looks like.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
}

export async function click(element: Element | null | undefined) {
    const { act } = await import('react');
    await act(async () => {
        if (!element) throw new Error('nothing to click');
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

export const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === label);

export const message = () => document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? null;
