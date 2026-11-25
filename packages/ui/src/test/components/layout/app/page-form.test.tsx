// A draft page on PageForm keeps the page contract: it opens on its first field, Enter and Cmd+Enter save once, a bad
// value is pointed at, Save shows that it is busy, and leaving with a change asks. Its Reset and Save show only once
// something changed, Enter on a page with nothing changed saves nothing, Reset puts back what was saved, and a failed
// save keeps the draft beside its hook's toast.
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { expectFormContract } from '../../../form-contract';
import { installHappyDom } from '../../../happy-dom';
import { pressEnter } from '../../../press-enter';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const router = await import('@tanstack/react-router');
const { onMutationError } = await import('@workspace/lib/api-error');
const { PageForm } = await import('../../../../components/layout/app/page-form');
const { FieldError } = await import('../../../../components/field');
const { Input } = await import('../../../../components/input');

const save = mock(async (_name: string) => {});
afterEach(() => {
    save.mockReset();
    save.mockImplementation(async () => {});
});

// A page whose one setting is a name, saved as Notes.
function NamePage(): ReactNode {
    const [saved, setSaved] = useState('Notes');
    const [name, setName] = useState(saved);
    const blank = name.trim() === '';
    return createElement(PageForm, {
        changed: name !== saved,
        onReset: () => setName(saved),
        onSubmit: async () => {
            if (blank) return false;
            await save(name);
            setSaved(name);
        },
        children: [
            createElement(Input, {
                key: 'name',
                'aria-label': 'Name',
                value: name,
                onChange: (event: { target: { value: string } }) => setName(event.target.value),
                'aria-invalid': blank || undefined,
            }),
            blank && createElement(FieldError, { key: 'error' }, 'Add a name'),
        ],
    });
}

// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
async function type(value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(nameField(), value);
        nameField().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function nameField(): HTMLInputElement {
    const input = document.querySelector('[aria-label="Name"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no Name field');
    return input;
}

const button = (label: string) =>
    [...document.querySelectorAll('button')].find((b) => b.lastChild?.textContent?.trim() === label);

async function openPage() {
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({ getParentRoute: () => root, path: '/', component: NamePage });
    const memory = router.createRouter({
        routeTree: root.addChildren([page]),
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
}

test('a draft page keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(NamePage),
        submitLabel: 'Save',
        firstField: 'Name',
        onSubmit: save,
        makeChanged: () => type('Plans'),
        makeInvalid: () => type(''),
        invalidField: 'Name',
    });
});

test('Reset and Save show once something changed, and Reset puts back what was saved', async () => {
    await openPage();
    expect(button('Save')).toBeUndefined();
    await type('Plans');
    expect(button('Save')).toBeDefined();
    await act(async () => button('Reset')?.click());
    expect(nameField().value).toBe('Notes');
    expect(button('Save')).toBeUndefined();
});

test('Enter on a page with nothing changed saves nothing', async () => {
    await openPage();
    await act(async () => pressEnter(nameField()));
    expect(save).not.toHaveBeenCalled();
});

test('a saved page hides its footer, and a failed save keeps the draft beside its toast', async () => {
    await openPage();
    await type('Plans');
    await act(async () => pressEnter(nameField()));
    expect(save).toHaveBeenCalledWith('Plans');
    expect(button('Save')).toBeUndefined();

    // The mutation hook toasts a failure before the page sees it, and the page leaves no rejection behind.
    save.mockImplementation(async () => {
        const failure = new Error('offline');
        onMutationError(failure);
        throw failure;
    });
    await type('Ideas');
    await act(async () => pressEnter(nameField()));
    expect(nameField().value).toBe('Ideas');
    expect(button('Save')?.getAttribute('aria-busy')).toBeNull();
});
