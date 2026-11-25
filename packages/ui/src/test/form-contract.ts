// The probes every form's test runs, so each form proves it keeps the rules its shell owns: focus on open, Enter and
// Cmd+Enter, closing with and without changes, the leave guard, an invalid submit, the pending button and a close while
// the save runs. A test renders the real form through `render` and calls expectFormContract once; the probes of its
// kind each render it afresh in a memory router. A form that breaks one on purpose names it in `except` with its
// reason. Call `installHappyDom()` first.
import type { Mock } from 'bun:test';
import type { ReactElement } from 'react';
import { pressEnter } from './press-enter';
import { pressKey } from './press-key';
import { renderInDocument } from './render-in-document';

type FormKind = 'dialog' | 'card' | 'page';

export type FormContract = {
    kind: FormKind;
    // The form, open, as its test sets it up with its mocks.
    render: () => ReactElement;
    submitLabel: string;
    // Fields go by their label, as a person finds them.
    firstField: string;
    // What a submit reaches, such as the form's mutation. The pending probe holds it.
    onSubmit: Mock<(...args: never[]) => unknown>;
    // Changes the form so that it saves, such as typing a title into a new event.
    makeChanged: () => Promise<void>;
    makeInvalid?: () => Promise<void>;
    invalidField?: string;
    // More fields that Cmd+Enter must submit from untouched, such as a multi-line one, a rich-text one, or one that
    // commits its value on Enter.
    modEnterFields?: string[];
    // The submit writes at once, such as into the open document, so no save runs to wait for.
    savesAtOnce?: boolean;
    // A page whose input is lost on leaving without harm, such as sign-in, which a password manager refills, has no
    // leave guard.
    noDraft?: boolean;
    // A probe this form breaks on purpose, with the reason, such as a subject where plain Enter must not send an email.
    except?: { [Name in ProbeName]?: string };
};

// In the order they run.
const PROBE_NAMES = [
    'focus',
    'enter',
    'modEnter',
    'close',
    'discard',
    'cardEsc',
    'leaveGuard',
    'invalid',
    'pending',
    'pendingClose',
] as const;
type ProbeName = (typeof PROBE_NAMES)[number];

type Probe = { kinds: readonly FormKind[]; run: (form: FormContract) => Promise<void> };

const PROBES: Record<ProbeName, Probe> = {
    focus: { kinds: ['dialog', 'card', 'page'], run: probeFocus },
    enter: { kinds: ['dialog', 'card', 'page'], run: probeEnter },
    modEnter: { kinds: ['dialog', 'card', 'page'], run: probeModEnter },
    close: { kinds: ['dialog'], run: probeClose },
    discard: { kinds: ['dialog'], run: probeDiscard },
    cardEsc: { kinds: ['card'], run: probeCardEsc },
    leaveGuard: { kinds: ['page'], run: probeLeaveGuard },
    invalid: { kinds: ['dialog', 'card', 'page'], run: probeInvalid },
    pending: { kinds: ['dialog', 'card', 'page'], run: probePending },
    pendingClose: { kinds: ['dialog', 'card'], run: probePendingClose },
};

export async function expectFormContract(form: FormContract): Promise<void> {
    for (const name of PROBE_NAMES) {
        const reason = form.except?.[name];
        if (reason !== undefined && !reason.trim()) throw new Error(`${name}: an exception says why`);
        if (reason === undefined && appliesTo(name, form)) await runProbe(name, PROBES[name], form);
    }
}

function appliesTo(name: ProbeName, form: FormContract): boolean {
    if (form.savesAtOnce && (name === 'pending' || name === 'pendingClose')) return false;
    if (form.noDraft && name === 'leaveGuard') return false;
    return PROBES[name].kinds.includes(form.kind);
}

// One probe, whatever the form's kind, for the probes' own tests.
export function expectFormProbe(name: ProbeName, form: FormContract): Promise<void> {
    return runProbe(name, PROBES[name], form);
}

async function runProbe(name: string, probe: Probe, form: FormContract) {
    try {
        await probe.run(form);
    } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function probeFocus(form: FormContract) {
    await withForm(form, async () => {
        const target = field(form.firstField);
        check(document.activeElement === target, `${form.firstField} has the focus as it opens, not ${focused()}`);
        const lone = form.kind !== 'page' && textFields(target).length === 1;
        // A number field selects its text but tells no selection (selectionStart is null), so its select goes unseen.
        if (lone && target instanceof HTMLInputElement && target.value && target.selectionStart !== null) {
            check(target.selectionStart !== target.selectionEnd, `the text of ${form.firstField} is selected`);
        }
    });
}

async function probeEnter(form: FormContract) {
    await withForm(form, async () => {
        await form.makeChanged();
        const line = textFields(submitButton(form)).find(isOneLine);
        if (!line) return;
        const release = hold(form.onSubmit);
        await act(() => pressEnter(line));
        check(calls(form) === 1, `Enter in ${labelOf(line)} submits, ran ${calls(form)} times`);
        await act(() => pressEnter(line));
        check(calls(form) === 1, `a second Enter while the first runs submits nothing, ran ${calls(form)} times`);
        await release();
    });
    await withForm(form, async () => {
        await form.makeChanged();
        const choice = submitButton(form).form?.querySelector(CHOICE);
        if (!choice) return;
        await act(() => pressKey(choice, 'Enter'));
        await nextTask();
        check(calls(form) === 1, `Enter on ${labelOf(choice)} submits, ran ${calls(form)} times`);
    });
}

// Each field submits on Cmd+Enter and on Ctrl+Enter, keeps its content, and lets no hotkey behind the form see the key.
// The save is held until the checks are done: on a slow machine the shell's deferred submit can run before the press's
// act returns, and a save that went through resets the draft, so the content check would read the reset.
async function probeModEnter(form: FormContract) {
    for (const label of [form.firstField, ...(form.modEnterFields ?? [])]) {
        for (const [key, modifier] of MODIFIERS) {
            await withForm(form, async () => {
                await form.makeChanged();
                const target = field(label);
                target.focus();
                const before = contentOf(target);
                const behind: KeyboardEvent[] = [];
                const listen = (event: KeyboardEvent) => behind.push(event);
                document.addEventListener('keydown', listen);
                const release = hold(form.onSubmit);
                await act(() => keydown(target, { key: 'Enter', ...modifier }));
                document.removeEventListener('keydown', listen);
                check(contentOf(target) === before, `${key}+Enter in ${label} leaves its content as it was`);
                await nextTask();
                check(calls(form) === 1, `${key}+Enter in ${label} submits, ran ${calls(form)} times`);
                check(behind.length === 0, `${key}+Enter in ${label} reaches no hotkey behind the form`);
                await release();
            });
        }
    }
}

async function probeClose(form: FormContract) {
    for (const [way, close] of CLOSES) {
        await withForm(form, async () => {
            await close();
            check(!openForm(form), `${way} closes a form with nothing changed`);
        });
    }
    await withForm(form, async () => {
        await form.makeChanged();
        await click(button('Cancel'));
        check(!asking('Discard changes?'), 'Cancel drops the changes without asking');
        check(!openForm(form), 'Cancel closes the form');
        check(calls(form) === 0, 'Cancel saves nothing');
    });
}

async function probeDiscard(form: FormContract) {
    for (const [way, close] of CLOSES) {
        await withForm(form, async () => {
            await form.makeChanged();
            // The field the change was typed in, or the first one for a change made from outside the form.
            const active = document.activeElement;
            const typedIn = active instanceof HTMLElement && active.closest('form') ? active : field(form.firstField);
            typedIn.focus();
            await close();
            check(asking('Discard changes?') && openForm(form), `${way} on a changed form asks "Discard changes?"`);
            await click(button('Keep editing'));
            // Radix moves the focus a task after the question is gone.
            await nextTask();
            check(!asking('Discard changes?') && openForm(form), 'Keep editing goes back to the form');
            check(
                document.activeElement === typedIn,
                `Keep editing after ${way} goes back to ${labelOf(typedIn)}, not ${focused()}`,
            );
            await close();
            check(asking('Discard changes?'), `${way} asks again after Keep editing`);
            await click(button('Discard'));
            check(!openForm(form), `Discard closes the form after ${way}`);
            check(calls(form) === 0, 'Discard saves nothing');
        });
    }
}

async function probeCardEsc(form: FormContract) {
    // Esc does what Cancel does: a card being edited goes back to its view, a new one closes.
    let viewAfterCancel = false;
    await withForm(form, async () => {
        await click(button('Cancel'));
        viewAfterCancel = !!document.querySelector('[role="dialog"]');
    });
    const afterEsc = (what: string) => {
        check(!openForm(form), `${what} leaves the edit`);
        check(!!document.querySelector('[role="dialog"]') === viewAfterCancel, `${what} does what Cancel does`);
    };
    await withForm(form, async () => {
        await pressEscape();
        afterEsc('Esc with nothing changed');
    });
    await withForm(form, async () => {
        await form.makeChanged();
        await pressEscape();
        check(asking('Discard changes?') && openForm(form), 'Esc on a changed card asks "Discard changes?"');
        await click(button('Keep editing'));
        check(!asking('Discard changes?') && openForm(form), 'Keep editing goes back to the edit');
        await pressEscape();
        await click(button('Discard'));
        afterEsc('Discard');
        check(calls(form) === 0, 'Discard saves nothing');
    });
}

async function probeLeaveGuard(form: FormContract) {
    await withForm(form, async ({ leave, at }) => {
        await leave();
        check(at() === ELSEWHERE, 'a page with nothing changed leaves at once');
    });
    await withForm(form, async ({ leave, at }) => {
        await form.makeChanged();
        await leave();
        check(at() === HERE && asking('Discard changes?'), 'a changed page asks "Discard changes?"');
        await click(button('Keep editing'));
        check(at() === HERE && openForm(form), 'Keep editing keeps the page and its form');
        await leave();
        await click(button('Discard'));
        check(at() === ELSEWHERE, 'Discard leaves');
        check(calls(form) === 0, 'leaving saves nothing');
    });
    // The save may fail, and the draft would be gone with the page.
    await withForm(form, async ({ leave, at }) => {
        await form.makeChanged();
        const release = hold(form.onSubmit);
        await click(submitButton(form));
        await leave();
        check(at() === HERE && asking('Discard changes?'), 'a changed page asks while its save runs');
        await click(button('Keep editing'));
        await release();
    });
}

async function probeInvalid(form: FormContract) {
    const { makeInvalid, invalidField } = form;
    if (!makeInvalid) return;
    if (!invalidField) throw new Error('a form with makeInvalid names its invalidField');
    await withForm(form, async () => {
        await makeInvalid();
        await click(submitButton(form));
        const target = field(invalidField);
        check(calls(form) === 0, `an invalid form saves nothing, ran ${calls(form)} times`);
        check(target.getAttribute('aria-invalid') === 'true', `${invalidField} is marked aria-invalid`);
        const message = target.closest('form')?.querySelector(MESSAGE);
        check(!!message?.textContent?.trim(), `a message under ${invalidField} says what is wrong`);
        check(document.activeElement === target, `${invalidField} has the focus, not ${focused()}`);
    });
}

async function probePending(form: FormContract) {
    await withForm(form, async () => {
        await form.makeChanged();
        const release = hold(form.onSubmit);
        const save = submitButton(form);
        save.focus();
        await click(save);
        check(save.getAttribute('aria-busy') === 'true', `${form.submitLabel} says it is busy while the save runs`);
        check(document.activeElement === save, `${form.submitLabel} keeps the focus while the save runs`);
        await click(save);
        check(calls(form) === 1, `a click while the save runs saves nothing more, ran ${calls(form)} times`);
        await act(() => keydown(field(form.firstField), { key: 'Enter', metaKey: true }));
        await nextTask();
        check(calls(form) === 1, `Cmd+Enter while the save runs saves nothing more, ran ${calls(form)} times`);
        await release();
    });
}

// Every close waits for a running save, which then decides, and a failed save keeps the form with what was typed.
async function probePendingClose(form: FormContract) {
    for (const [way, close] of CLOSES) {
        await withForm(form, async () => {
            await form.makeChanged();
            const release = hold(form.onSubmit);
            await click(submitButton(form));
            await close();
            check(openForm(form), `${way} while the save runs leaves the form open`);
            check(!asking('Discard changes?'), `${way} while the save runs asks nothing`);
            await release();
        });
    }
    await withForm(form, async () => {
        await form.makeChanged();
        const typed = contentOf(field(form.firstField));
        const release = hold(form.onSubmit, { fails: true });
        await click(submitButton(form));
        await release();
        check(openForm(form), 'a failed save keeps the form open');
        check(contentOf(field(form.firstField)) === typed, `a failed save keeps what was typed in ${form.firstField}`);
    });
}

const HERE = '/';
const ELSEWHERE = '/elsewhere';

// Renders the form at HERE in a memory router that can leave for ELSEWHERE, and unmounts it after `body`.
async function withForm(
    form: FormContract,
    body: (page: { leave: () => Promise<void>; at: () => string }) => Promise<void>,
): Promise<void> {
    const [{ createElement }, router] = await Promise.all([import('react'), import('@tanstack/react-router')]);
    const element = form.render();
    const root = router.createRootRoute({ component: router.Outlet });
    const here = router.createRoute({ getParentRoute: () => root, path: HERE, component: () => element });
    const elsewhere = router.createRoute({ getParentRoute: () => root, path: ELSEWHERE, component: () => 'Elsewhere' });
    const memory = router.createRouter({
        routeTree: root.addChildren([here, elsewhere]),
        history: router.createMemoryHistory({ initialEntries: [HERE] }),
    });
    await memory.load();
    form.onSubmit.mockClear();
    const { unmount } = await renderInDocument(createElement(router.RouterProvider, { router: memory }));
    try {
        await body({
            // Through the history, since an app's registered routes type the router's `to` and refuse ELSEWHERE.
            leave: () => act(() => memory.history.push(ELSEWHERE)),
            at: () => memory.state.location.pathname,
        });
    } finally {
        await unmount();
    }
}

// The three closes that may lose a change, as a person does them.
const CLOSES: readonly (readonly [string, () => Promise<void>])[] = [
    ['Esc', () => pressEscape()],
    ['the X', () => click(document.querySelector('[data-slot="dialog-close"]'))],
    ['a click outside', () => clickOutside()],
];

// The whole press on the top overlay, since Radix waits for the click before it closes. A dialog that rendered again,
// such as after a question over it closed, listens again only from the next tick.
async function clickOutside() {
    await tick();
    const overlay = [...document.querySelectorAll('[data-slot="dialog-overlay"]')].at(-1);
    if (!overlay) throw new Error('no dialog is open');
    await act(() => {
        // The press on something that takes no focus takes it from the field, as a browser's does.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        overlay.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    await tick();
}

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

// The shell submits a key's form on the next task, once React has rendered what the key changed.
const nextTask = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const MODIFIERS = [
    ['Cmd', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
] as const;

const CHOICE = '[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]';
const MESSAGE = '[data-slot="field-error"], [data-slot="form-message"]';
const ONE_LINE_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

// Holds every submit until the returned release, then lets each run as it would have, or fail as a mutation whose
// hook toasted the error does.
function hold(onSubmit: FormContract['onSubmit'], { fails = false } = {}): () => Promise<void> {
    const original = onSubmit.getMockImplementation();
    const { promise, resolve } = Promise.withResolvers<void>();
    onSubmit.mockImplementation((...args) =>
        promise.then(async () => {
            if (!fails) return original?.(...args);
            const { onMutationError } = await import('@workspace/lib/api-error');
            const failure = new Error('offline');
            onMutationError(failure);
            throw failure;
        }),
    );
    return async () => {
        await act(async () => resolve());
        onSubmit.mockImplementation(original ?? (() => undefined));
    };
}

async function act(callback: () => unknown): Promise<void> {
    const react = await import('react');
    await react.act(async () => {
        await callback();
    });
}

const keydown = (target: Element, init: KeyboardEventInit) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
};

const pressEscape = () => act(() => keydown(document.activeElement ?? document.body, { key: 'Escape' }));

// A press focuses a button before it clicks it, as a browser's does.
const click = (target: Element | null) =>
    act(() => {
        if (!(target instanceof HTMLElement)) throw new Error('nothing to click');
        target.focus();
        target.click();
    });

const calls = (form: FormContract) => form.onSubmit.mock.calls.length;

// A pending button's spinner comes before its label.
const labelOf = (element: Element) =>
    element.getAttribute('aria-label') ?? element.lastChild?.textContent?.trim() ?? element.tagName;

function button(label: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].filter((b) => labelOf(b) === label).at(-1);
    if (!found) throw new Error(`no ${label} button`);
    return found;
}

function submitButton(form: FormContract): HTMLButtonElement {
    return button(form.submitLabel);
}

const openForm = (form: FormContract) =>
    [...document.querySelectorAll('button')].some((b) => labelOf(b) === form.submitLabel);

const asking = (title: string) =>
    [...document.querySelectorAll('[role="dialog"] h2, [role="alertdialog"] h2')].some((h) => h.textContent === title);

const focused = () => {
    const element = document.activeElement;
    return element && element !== document.body ? labelOf(element) : 'nothing';
};

// The field a label names: its aria-label, its aria-labelledby, or a <label> tied to it.
export function field(label: string): HTMLElement {
    for (const element of document.querySelectorAll<HTMLElement>('[aria-label], [aria-labelledby]')) {
        const name =
            element.getAttribute('aria-label') ??
            element
                .getAttribute('aria-labelledby')
                ?.split(' ')
                .map((id) => document.getElementById(id)?.textContent)
                .join(' ');
        if (name === label) return element;
    }
    for (const tag of document.querySelectorAll('label')) {
        const tied = tag.htmlFor ? document.getElementById(tag.htmlFor) : tag.querySelector('input, textarea, select');
        if (tag.textContent?.trim() === label && tied instanceof HTMLElement) return tied;
    }
    throw new Error(`no field labelled ${label}`);
}

// Types into a field, or the field a label names, as a keystroke does: React reads the value off its own tracker, so
// the native setter is what reaches it.
export async function type(target: string | HTMLElement, value: string): Promise<void> {
    const input = typeof target === 'string' ? field(target) : target;
    const setter =
        input instanceof HTMLTextAreaElement
            ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
            : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || !setter) {
        throw new Error(`${labelOf(input)} takes no typing`);
    }
    await act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

const contentOf = (element: HTMLElement) =>
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerHTML;

function textFields(inside: Element): HTMLElement[] {
    const form = inside.closest('form');
    if (!form) return [];
    return [...form.querySelectorAll<HTMLElement>('input, textarea, [contenteditable="true"]')].filter(
        (element) => !(element instanceof HTMLInputElement) || isOneLine(element),
    );
}

function isOneLine(element: Element): element is HTMLInputElement {
    return element instanceof HTMLInputElement && ONE_LINE_TYPES.has(element.type) && !element.disabled;
}

function check(condition: boolean, rule: string): asserts condition {
    if (!condition) throw new Error(rule);
}
