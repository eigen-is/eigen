// Mounts a sheet dialog the way the app opens one: under the workbook's context and the modal host, opened through
// useDialog by the test's `open`. Import it after installHappyDom. The test reads the workbook back after a submit, and finds the dialog,
// its fields and its buttons in the document.

import { renderInDocument } from '@workspace/ui/test/render-in-document';
import { produce } from 'immer';
import { act, createElement, createRef, useState } from 'react';
import type { RefValues } from '../../context';
import { WorkbookContext } from '../../context';
import { ModalProvider } from '../../context/modal';
import { useDialog } from '../../hooks/useDialog';
import type { Context, SheetConfig } from '../../state';
import { defaultSettings } from '../../state';
import { workbookContextFactory } from '../state/factories/context';

const refs: RefValues = {
    globalCache: {
        undoList: [],
        redoList: [],
        scrollLeft: 0,
        scrollTop: 0,
        scrollListeners: new Set<() => void>(),
        notifyScrollListeners: () => {},
    },
    // The in-cell editor, which the grid always mounts: a format or a function is applied through it.
    cellInput: { current: document.createElement('div') },
    fxInput: createRef<HTMLDivElement | null>(),
    canvas: createRef<HTMLCanvasElement | null>(),
    cellArea: createRef<HTMLDivElement | null>(),
    workbookContainer: createRef<HTMLDivElement | null>(),
};

type Dialogs = ReturnType<typeof useDialog>;

// What the test reads back: the workbook as the last write left it, and the opener the host handed out.
type Harness = { context: Context; dialogs?: Dialogs };

function Opener({ harness }: { harness: Harness }) {
    harness.dialogs = useDialog();
    return null;
}

function Workbook({ harness }: { harness: Harness }) {
    const [rendered, setRendered] = useState(harness.context);
    const value = {
        context: rendered,
        getContext: () => harness.context,
        setContext: (recipe: (ctx: Context) => void) => {
            harness.context = produce(harness.context, recipe);
            setRendered(harness.context);
        },
        settings: defaultSettings,
        refs,
        handleUndo: () => {},
        handleRedo: () => {},
    };
    return createElement(
        WorkbookContext.Provider,
        { value },
        createElement(ModalProvider, null, createElement(Opener, { harness })),
    );
}

export async function renderSheetDialog(
    open: (dialogs: Dialogs) => void,
    params: Partial<Context> & { config?: SheetConfig } = {},
) {
    const harness: Harness = { context: workbookContextFactory(params) };
    await renderInDocument(createElement(Workbook, { harness }));
    await act(async () => {
        if (!harness.dialogs) throw new Error('the host did not render');
        open(harness.dialogs);
    });

    const button = (label: string) =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
            (b) => b.textContent === label,
        );
    const field = (label: string) => {
        const input = document.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="${label}"]`);
        if (!input) throw new Error(`no field ${label}`);
        return input;
    };

    return {
        context: () => harness.context,
        // Every dialog in the document: one, unless a shell wraps another.
        dialogs: () => [...document.querySelectorAll('[role="dialog"]')],
        title: () => document.querySelector('[role="dialog"] h2')?.textContent,
        // The labels of the footer's buttons, which leaves out the corner X.
        footer: () =>
            [...document.querySelectorAll('[role="dialog"] [data-slot="dialog-footer"] button')].map(
                (b) => b.textContent,
            ),
        button,
        field,
        click: (label: string) =>
            act(async () => {
                const target = button(label);
                if (!target) throw new Error(`no ${label} button`);
                target.click();
            }),
        type: (label: string, value: string) =>
            act(async () => {
                const input = field(label);
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }),
    };
}
