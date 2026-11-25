// Mounts a sheet dialog the way the app opens one: under the workbook's context and the modal host, opened through
// useDialog by the test's `open`. A part the grid draws itself, such as the link card, goes in `grid`, beside it.
// Import it after installHappyDom. The test reads the workbook back after a submit, and finds the dialog, its fields
// and its buttons in the document. sheetDialogForm hands expectFormContract the same mount as an element.

import { mock } from 'bun:test';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import { produce } from 'immer';
import type { ReactNode } from 'react';
import { act, createElement, createRef, useEffect, useState } from 'react';
import { WorkbookContext } from '../../context';
import { ModalProvider } from '../../context/modal';
import { useDialog } from '../../hooks/useDialog';
import type { Context, RefValues, SheetConfig } from '../../state';
import { workbookContextFactory } from '../state/factories/context';

// The workbook's refs, fresh for each render.
function workbookRefs(): RefValues {
    return {
        globalCache: {
            undoList: [],
            redoList: [],
            scrollLeft: 0,
            scrollTop: 0,
            scrollListeners: new Set<() => void>(),
        },
        cellInput: createRef<HTMLDivElement | null>(),
        fxInput: createRef<HTMLDivElement | null>(),
        canvas: createRef<HTMLCanvasElement | null>(),
        cellArea: createRef<HTMLDivElement | null>(),
        workbookContainer: createRef<HTMLDivElement | null>(),
        hooks: { current: {} },
    };
}

type Dialogs = ReturnType<typeof useDialog>;
type Recipe = (ctx: Context) => void;

// What the test reads back: the workbook as the last write left it, and the opener the host handed out. `grid` draws
// what the workbook draws under the host from its context. A mount for the contract opens its dialog as it mounts, and
// its dialog writes through `write`.
type Harness = {
    context: Context;
    refs: RefValues;
    dialogs?: Dialogs;
    setContext?: (recipe: Recipe) => void;
    grid?: (context: Context) => ReactNode;
    opensOnMount?: (dialogs: Dialogs) => void;
    write?: (recipe: Recipe) => void;
};

function Opener({ harness }: { harness: Harness }) {
    const dialogs = useDialog();
    harness.dialogs = dialogs;
    const { opensOnMount } = harness;
    useEffect(() => opensOnMount?.(dialogs), [opensOnMount, dialogs]);
    return null;
}

function Workbook({ harness }: { harness: Harness }) {
    const [rendered, setRendered] = useState(harness.context);
    harness.setContext = (recipe: Recipe) => {
        harness.context = produce(harness.context, recipe);
        setRendered(harness.context);
    };
    const value = {
        context: rendered,
        getContext: () => harness.context,
        setContext: harness.write ?? harness.setContext,
        aspectLocked: false,
        refs: harness.refs,
        handleUndo: () => {},
        handleRedo: () => {},
        pasteClipboard: () => {},
    };
    return createElement(
        WorkbookContext.Provider,
        { value },
        createElement(
            ModalProvider,
            null,
            createElement(Opener, { harness }),
            // The in-cell editor, which the grid always mounts. A format or a function is applied through it, and it
            // takes the grid's keys.
            createElement('div', { ref: harness.refs.cellInput, id: 'sheet-rich-text-editor', contentEditable: true }),
            harness.grid?.(rendered),
        ),
    );
}

type Params = Partial<Context> & { config?: SheetConfig };

// What a sheet dialog's contract skips: its submit writes the workbook at once, so there is nothing to wait for.
export const SYNCHRONOUS_WRITE = {
    pending: 'the submit writes the workbook at once, so no save runs',
    pendingClose: 'the submit writes the workbook at once, so no save runs',
};

// The dialog `open` opens, as an element expectFormContract renders afresh for each probe. Every write the dialog makes
// reaches `write`, the submit the contract counts and holds. `context` reads the workbook of the last render.
export function sheetDialogForm(open: (dialogs: Dialogs) => void, params: Params = {}) {
    let harness: Harness | undefined;
    const write = mock((recipe: Recipe) => harness?.setContext?.(recipe));
    const render = () => {
        const refs = workbookRefs();
        harness = {
            context: workbookContextFactory({ getRefs: () => refs, ...params }),
            refs,
            opensOnMount: open,
            write,
        };
        return createElement(Workbook, { harness });
    };
    return { render, write, context: () => harness?.context };
}

export async function renderSheetDialog(
    open: (dialogs: Dialogs) => void,
    params: Params = {},
    grid?: (context: Context) => ReactNode,
) {
    const refs = workbookRefs();
    const harness: Harness = { context: workbookContextFactory({ getRefs: () => refs, ...params }), refs, grid };
    await renderInDocument(createElement(Workbook, { harness }));
    // Opens a dialog in the slot the way the app does, such as a confirm over the one open.
    const show = (open: (dialogs: Dialogs) => void) =>
        act(async () => {
            if (!harness.dialogs) throw new Error('the host did not render');
            open(harness.dialogs);
        });
    await show(open);

    // A button by its text, or an icon button by its name.
    const name = (b: Element) => b.textContent || b.getAttribute('aria-label');
    const button = (label: string) =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => name(b) === label);
    const { cellInput } = harness.refs;
    const setContext = (recipe: Recipe) =>
        act(async () => {
            if (!harness.setContext) throw new Error('the workbook did not render');
            harness.setContext(recipe);
        });

    return {
        context: () => harness.context,
        // A write to the workbook from outside the dialog, such as a switch to another sheet.
        setContext,
        show,
        // The text in the in-cell editor, where Insert function writes its pick.
        editorText: () => cellInput.current?.textContent,
        setEditorText: (text: string) => {
            if (cellInput.current) cellInput.current.textContent = text;
        },
        // Every dialog in the document: one, unless a shell wraps another.
        dialogs: () => [...document.querySelectorAll('[role="dialog"]')],
        title: () => document.querySelector('[role="dialog"] h2')?.textContent,
        // The names of the footer's buttons, which leaves out the corner X.
        footer: () => [...document.querySelectorAll('[role="dialog"] [data-slot="dialog-footer"] button')].map(name),
        button,
        field,
        click: (label: string) =>
            act(async () => {
                const target = button(label);
                if (!target) throw new Error(`no ${label} button`);
                target.click();
            }),
        type: typeInto,
    };
}

// A field by its name: its aria-label, or the text of the label element that points at it.
function field(label: string) {
    const labelled = [...document.querySelectorAll('[role="dialog"] label')].find((l) => l.textContent === label);
    const input =
        document.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="${label}"]`) ??
        (labelled instanceof HTMLLabelElement ? labelled.control : null);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${label}`);
    return input;
}

// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
export const typeInto = (label: string, value: string) =>
    act(async () => {
        const input = field(label);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
