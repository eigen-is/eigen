// A draft page on PageForm keeps the page contract: it opens on its first field, Enter and Cmd+Enter save once, a bad
// value is pointed at, Save shows that it is busy, and leaving with a change asks. Its Reset and Save show only once
// something changed, Enter on a page with nothing changed saves nothing, Reset puts back what was saved, and a failed
// save keeps the draft beside its hook's toast. A page form with no Reset, such as Change password, keeps the contract
// too, and shows its button all along, so a Save with nothing typed still runs and says what is missing. An edit opened
// from a view shows Cancel and Save throughout, Cancel goes back to the view, and its Save runs with nothing changed,
// leaving the caller to go back. A page that makes one thing shows Cancel and its own label, such as Create, from
// the start, and keeps the same contract.
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { expectFormContract, type } from '../../../form-contract';
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

// A page that makes one thing, such as a new contact, with Cancel beside its Create.
function NewNotePage(): ReactNode {
    const [name, setName] = useState('');
    const blank = name.trim() === '';
    return createElement(PageForm, {
        changed: name !== '',
        onCancel: cancel,
        submitLabel: 'Create',
        onSubmit: async () => {
            if (blank) return false;
            await save(name);
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

const cancel = mock(() => {});

function nameField(): HTMLInputElement {
    const input = document.querySelector('[aria-label="Name"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no Name field');
    return input;
}

const button = (label: string) =>
    [...document.querySelectorAll('button')].find((b) => b.lastChild?.textContent?.trim() === label);

// A page form with no draft to reset, whose one field is a name to send.
function SendPage(): ReactNode {
    const [name, setName] = useState('');
    return createElement(PageForm, {
        changed: name !== '',
        submitLabel: 'Send',
        onSubmit: () => save(name),
        children: createElement(Input, {
            'aria-label': 'Name',
            value: name,
            onChange: (event: { target: { value: string } }) => setName(event.target.value),
        }),
    });
}

async function openPage(component: () => ReactNode = NamePage) {
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({ getParentRoute: () => root, path: '/', component });
    const elsewhere = router.createRoute({
        getParentRoute: () => root,
        path: '/elsewhere',
        component: () => 'Elsewhere',
    });
    const memory = router.createRouter({
        routeTree: root.addChildren([page, elsewhere]),
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
    return memory;
}

test('a draft page keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(NamePage),
        submitLabel: 'Save',
        firstField: 'Name',
        onSubmit: save,
        makeChanged: () => type('Name', 'Plans'),
        makeInvalid: () => type('Name', ''),
        invalidField: 'Name',
    });
});

test('a page form with no Reset keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(SendPage),
        submitLabel: 'Send',
        firstField: 'Name',
        onSubmit: save,
        makeChanged: () => type('Name', 'Plans'),
    });
});

test('a page form with no Reset shows its button all along, and sends with nothing typed', async () => {
    await openPage(SendPage);
    expect(button('Reset')).toBeUndefined();
    expect(button('Cancel')).toBeUndefined();
    await act(async () => button('Send')?.click());
    expect(save).toHaveBeenCalledWith('');
});

test('Reset and Save show once something changed, and Reset puts back what was saved', async () => {
    await openPage();
    expect(button('Save')).toBeUndefined();
    await type('Name', 'Plans');
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
    await type('Name', 'Plans');
    await act(async () => pressEnter(nameField()));
    expect(save).toHaveBeenCalledWith('Plans');
    expect(button('Save')).toBeUndefined();

    // The mutation hook toasts a failure before the page sees it, and the page leaves no rejection behind.
    save.mockImplementation(async () => {
        const failure = new Error('offline');
        onMutationError(failure);
        throw failure;
    });
    await type('Name', 'Ideas');
    await act(async () => pressEnter(nameField()));
    expect(nameField().value).toBe('Ideas');
    expect(button('Save')?.getAttribute('aria-busy')).toBeNull();
});

// The same name, edited from a view of it, as a team's settings are.
function NameView(): ReactNode {
    const [editing, setEditing] = useState(true);
    const [name, setName] = useState('Notes');
    if (!editing) return createElement('button', { type: 'button', onClick: () => setEditing(true) }, 'Edit');
    return createElement(PageForm, {
        changed: name !== 'Notes',
        onCancel: () => setEditing(false),
        submitLabel: 'Save',
        // Saves only a change, and goes back either way, as Team settings does.
        onSubmit: async () => {
            if (name !== 'Notes') await save(name);
            setEditing(false);
        },
        children: createElement(Input, {
            'aria-label': 'Name',
            value: name,
            onChange: (event: { target: { value: string } }) => setName(event.target.value),
        }),
    });
}

test('an edit opened from a view keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(NameView),
        submitLabel: 'Save',
        firstField: 'Name',
        onSubmit: save,
        makeChanged: () => type('Name', 'Plans'),
    });
});

test('an edit opened from a view shows Cancel and Save throughout, and Cancel goes back to the view', async () => {
    await openPage(NameView);
    expect(button('Reset')).toBeUndefined();
    expect(button('Save')).toBeDefined();
    await type('Name', 'Plans');
    await act(async () => button('Cancel')?.click());
    expect(button('Edit')).toBeDefined();
    expect(save).not.toHaveBeenCalled();
});

test('Save with nothing changed runs the submit, which here goes back and saves nothing', async () => {
    await openPage(NameView);
    await act(async () => pressEnter(nameField()));
    expect(button('Edit')).toBeDefined();
    expect(save).not.toHaveBeenCalled();
});

test('a page with Cancel keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(NewNotePage),
        submitLabel: 'Create',
        firstField: 'Name',
        onSubmit: save,
        makeChanged: () => type('Name', 'Plans'),
        makeInvalid: () => type('Name', ' '),
        invalidField: 'Name',
    });
});

test('a page with Cancel shows Cancel and its label from the start, and its submit runs with nothing changed', async () => {
    cancel.mockClear();
    await openPage(NewNotePage);
    expect(button('Reset')).toBeUndefined();
    await act(async () => button('Create')?.click());
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(nameField());
    await act(async () => button('Cancel')?.click());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
});

// A page that opens what it made once the save lands, as Create contact opens the new contact.
function CreateAndOpenPage(): ReactNode {
    const navigate = router.useNavigate();
    const [name, setName] = useState('');
    return createElement(PageForm, {
        changed: name !== '',
        submitLabel: 'Create',
        onSubmit: async () => {
            await save(name);
            await navigate({ to: '/elsewhere', ignoreBlocker: true });
        },
        children: createElement(Input, {
            'aria-label': 'Name',
            value: name,
            onChange: (event: { target: { value: string } }) => setName(event.target.value),
        }),
    });
}

const asking = () =>
    [...document.querySelectorAll('[role="dialog"] h2')].some((h) => h.textContent === 'Discard changes?');

test('a link while the save runs asks, since a failed save would lose the draft', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    save.mockImplementation(() => promise);
    const memory = await openPage(CreateAndOpenPage);
    await type('Name', 'Plans');
    await act(async () => button('Create')?.click());
    await act(async () => memory.history.push('/elsewhere'));
    expect(memory.state.location.pathname).toBe('/');
    expect(asking()).toBe(true);
    await act(async () => resolve());
});

test("a save's own navigation goes through without asking", async () => {
    const memory = await openPage(CreateAndOpenPage);
    await type('Name', 'Plans');
    await act(async () => button('Create')?.click());
    expect(save).toHaveBeenCalledWith('Plans');
    expect(memory.state.location.pathname).toBe('/elsewhere');
    expect(asking()).toBe(false);
});
