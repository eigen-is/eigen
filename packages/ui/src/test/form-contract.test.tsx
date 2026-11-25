// expectFormContract passes a form that keeps every rule of its kind, and each probe fails a sample form that breaks
// its rule, naming the probe. A form skips a probe only with a reason, or as one that saves at once or keeps no draft.
// The dialog shell keeps the rules, and hand-built card and page samples prove the card's Esc and the page's leave guard
// both ways.
import { expect, mock, test } from 'bun:test';
import type { ComponentProps, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { FormContract } from './form-contract';
import { installHappyDom } from './happy-dom';

installHappyDom();

const { createElement, useRef, useState } = await import('react');
const { rethrowUntoasted } = await import('@workspace/lib/api-error');
const { expectFormContract, expectFormProbe, type } = await import('./form-contract');
const { FormDialog, FormDialogForm } = await import('../components/form-dialog');
const { FormShell } = await import('../components/form-shell');
const { Button } = await import('../components/button');
const { Checkbox } = await import('../components/checkbox');
const { ConfirmDialog } = await import('../components/confirm-dialog');
const { Dialog, DialogContent, DialogFooter, DialogTitle } = await import('../components/dialog');
const { FieldError } = await import('../components/field');
const { Input } = await import('../components/input');
const { LeaveGuard } = await import('../components/layout/app/leave-guard');

type Save = (name: string) => Promise<void>;

function contract(kind: FormContract['kind'], render: (onSubmit: Save) => ReactNode): FormContract {
    const onSubmit = mock<Save>(async () => {});
    return {
        kind,
        render: () => createElement('div', null, render(onSubmit)),
        submitLabel: 'Save',
        firstField: 'Name',
        onSubmit,
        makeChanged: () => type('Name', 'Plans'),
        makeInvalid: () => type('Name', ''),
        invalidField: 'Name',
    };
}

const expectProbeToFail = (probe: Parameters<typeof expectFormProbe>[0], form: FormContract, rule: string) =>
    expect(expectFormProbe(probe, form)).rejects.toThrow(`${probe}: ${rule}`);

// The name and its check, as a rename's fields are.
function NameField({ name, setName, error, onKeyDown, showsError = true }: NameFieldProps) {
    return [
        createElement(Input, {
            key: 'name',
            'aria-label': 'Name',
            value: name,
            onChange: (event: { target: { value: string } }) => setName(event.target.value),
            'aria-invalid': !!error || undefined,
            onKeyDown,
        }),
        showsError && error && createElement(FieldError, { key: 'error' }, error),
    ];
}
type NameFieldProps = {
    name: string;
    setName: (name: string) => void;
    error: string;
    onKeyDown?: (event: ReactKeyboardEvent) => void;
    showsError?: boolean;
};

type ShellDialogProps = {
    onSubmit: Save;
    onOpenAutoFocus?: (event: Event) => void;
    onNameKeyDown?: (event: ReactKeyboardEvent) => void;
    onChoiceKeyDown?: (event: ReactKeyboardEvent) => void;
    // Tells the shell when the name changed, as every form must.
    reportsChange?: boolean;
    // Writes at once instead of awaiting the save, as a Sheets dialog writes the workbook.
    writesAtOnce?: boolean;
    showsError?: boolean;
    extra?: ReactNode;
};

// A rename on the dialog shell, with a checkbox beside the name.
function ShellDialog({
    onSubmit,
    onOpenAutoFocus,
    onNameKeyDown,
    onChoiceKeyDown,
    reportsChange = true,
    writesAtOnce = false,
    showsError,
    extra,
}: ShellDialogProps) {
    const [open, setOpen] = useState(true);
    const [name, setName] = useState('Notes');
    const [error, setError] = useState('');
    return createElement(FormDialog, {
        open,
        onOpenChange: setOpen,
        title: 'Rename',
        onOpenAutoFocus,
        children: createElement(FormDialogForm, {
            changed: reportsChange && name !== 'Notes',
            submitLabel: 'Save',
            onSubmit: async () => {
                if (!name.trim()) {
                    setError('Add a name');
                    return false;
                }
                if (writesAtOnce) onSubmit(name);
                else await onSubmit(name);
            },
            children: [
                ...NameField({ name, setName, error, onKeyDown: onNameKeyDown, showsError }),
                createElement(
                    'span',
                    { key: 'copy', onKeyDown: onChoiceKeyDown },
                    createElement(Checkbox, { 'aria-label': 'Keep a copy' }),
                ),
                extra,
            ],
        }),
    });
}

type LooseDialogProps = {
    onSubmit: Save;
    // Ignores a second submit while one runs.
    guarded?: boolean;
    // Draws its Save as Button's pending does.
    busy?: boolean;
    content?: Partial<ComponentProps<typeof DialogContent>>;
    cancelCloses?: boolean;
    // Submits on Cmd+Enter and lets the key go on, as a form with its own shortcut may.
    modEnter?: boolean;
    // Ignores a close while the save runs.
    waits?: boolean;
    // Closes on a failed save too, where it otherwise stays open.
    closesOnFailure?: boolean;
};

// A rename built by hand on a plain <form>, as a dialog off the shell is.
function LooseDialog({
    onSubmit,
    guarded = false,
    busy = false,
    content,
    cancelCloses = true,
    modEnter = false,
    waits = false,
    closesOnFailure = false,
}: LooseDialogProps) {
    const [open, setOpen] = useState(true);
    const [name, setName] = useState('Notes');
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const running = useRef(false);
    const save = async () => {
        if (!name.trim()) return setError('Add a name');
        if (guarded && running.current) return;
        running.current = true;
        setPending(true);
        const failed = await onSubmit(name).then(
            () => false,
            () => true,
        );
        running.current = false;
        setPending(false);
        if (!failed || closesOnFailure) setOpen(false);
    };
    return createElement(
        Dialog,
        { open, onOpenChange: (next: boolean) => (waits && pending) || setOpen(next) },
        createElement(
            DialogContent,
            content ?? {},
            createElement(DialogTitle, null, 'Rename'),
            createElement(
                'form',
                {
                    onSubmit: (event: { preventDefault: () => void }) => {
                        event.preventDefault();
                        save();
                    },
                    onKeyDown: (event: ReactKeyboardEvent<HTMLFormElement>) => {
                        if (modEnter && event.key === 'Enter' && event.metaKey) event.currentTarget.requestSubmit();
                    },
                },
                ...NameField({ name, setName, error }),
                createElement(
                    DialogFooter,
                    null,
                    createElement(Button, { onClick: () => cancelCloses && setOpen(false) }, 'Cancel'),
                    createElement('button', { type: 'submit', 'aria-busy': (busy && pending) || undefined }, 'Save'),
                ),
            ),
        ),
    );
}

// Saves once at a time and says so on its button, as the card and page shells do. A toasted failure ends here.
function useSave(onSubmit: Save, name: string, setError: (error: string) => void) {
    const [pending, setPending] = useState(false);
    const save = async () => {
        if (!name.trim()) {
            setError('Add a name');
            return false;
        }
        setPending(true);
        try {
            await onSubmit(name);
        } catch (error) {
            rethrowUntoasted(error);
        } finally {
            setPending(false);
        }
    };
    return { pending, save };
}

// A card that opens in its edit and goes back to its view on Cancel, or on Esc when `escToView` holds. It ignores
// every close while its save runs.
function CardSample({ onSubmit, escToView }: { onSubmit: Save; escToView: boolean }) {
    const [open, setOpen] = useState(true);
    const [editing, setEditing] = useState(true);
    const [asking, setAsking] = useState(false);
    const [name, setName] = useState('Notes');
    const [error, setError] = useState('');
    const { pending, save } = useSave(onSubmit, name, setError);
    const toView = () => {
        setName('Notes');
        setEditing(false);
    };
    return [
        createElement(
            Dialog,
            { key: 'card', open, onOpenChange: (next: boolean) => pending || setOpen(next) },
            createElement(
                DialogContent,
                {
                    onEscapeKeyDown: (event: KeyboardEvent) => {
                        if (!editing || !escToView) return;
                        event.preventDefault();
                        if (pending) return;
                        if (name !== 'Notes') setAsking(true);
                        else toView();
                    },
                },
                createElement(DialogTitle, null, 'Card'),
                editing
                    ? createElement(FormShell, {
                          onSubmit: () => (pending ? undefined : save()),
                          children: [
                              createElement(Input, {
                                  key: 'name',
                                  'aria-label': 'Name',
                                  autoFocus: true,
                                  onFocus: (event: { target: { select: () => void } }) => event.target.select(),
                                  value: name,
                                  onChange: (event: { target: { value: string } }) => setName(event.target.value),
                                  'aria-invalid': !!error || undefined,
                              }),
                              error && createElement(FieldError, { key: 'error' }, error),
                              createElement(Button, { key: 'cancel', onClick: toView }, 'Cancel'),
                              createElement(Button, { key: 'save', type: 'submit', pending }, 'Save'),
                          ],
                      })
                    : createElement('p', null, name),
            ),
        ),
        createElement(ConfirmDialog, {
            key: 'ask',
            open: asking,
            onOpenChange: setAsking,
            title: 'Discard changes?',
            description: 'What you changed is not saved.',
            cancelText: 'Keep editing',
            confirmText: 'Discard',
            destructive: true,
            onConfirm: toView,
        }),
    ];
}

// A settings page on FormShell, guarded while it holds a change, or only while no save runs, or not at all. Unless
// `oneAtATime` is off it ignores a submit while one runs, beyond the pending Save that ignores a click.
function PageSample({
    onSubmit,
    guard,
    oneAtATime = true,
}: {
    onSubmit: Save;
    guard: 'always' | 'idle' | 'none';
    oneAtATime?: boolean;
}) {
    const [name, setName] = useState('Notes');
    const [error, setError] = useState('');
    const { pending, save } = useSave(onSubmit, name, setError);
    return createElement(FormShell, {
        onSubmit: () => (pending && oneAtATime ? undefined : save()),
        children: [
            createElement(Input, {
                key: 'name',
                'aria-label': 'Name',
                autoFocus: true,
                value: name,
                onChange: (event: { target: { value: string } }) => setName(event.target.value),
                'aria-invalid': !!error || undefined,
            }),
            error && createElement(FieldError, { key: 'error' }, error),
            createElement(Button, { key: 'save', type: 'submit', pending }, 'Save'),
            guard !== 'none' &&
                createElement(LeaveGuard, {
                    key: 'guard',
                    active: name !== 'Notes' && (guard === 'always' || !pending),
                }),
        ],
    });
}

const shell = (props: Omit<ShellDialogProps, 'onSubmit'> = {}) =>
    contract('dialog', (onSubmit) => createElement(ShellDialog, { onSubmit, ...props }));
const loose = (props: Omit<LooseDialogProps, 'onSubmit'> = {}) =>
    contract('dialog', (onSubmit) => createElement(LooseDialog, { onSubmit, ...props }));
const card = (escToView: boolean) => contract('card', (onSubmit) => createElement(CardSample, { onSubmit, escToView }));
const page = (guard: 'always' | 'idle' | 'none', oneAtATime?: boolean) =>
    contract('page', (onSubmit) => createElement(PageSample, { onSubmit, guard, oneAtATime }));

test('a dialog on the shell keeps the contract', async () => {
    await expectFormContract(shell());
});

test('a card that goes back to its view on Esc keeps the card contract and its Esc probe', async () => {
    await expectFormContract(card(true));
    await expectFormProbe('cardEsc', card(true));
});

test('a page with a leave guard keeps the page contract, and one without fails it', async () => {
    await expectFormContract(page('always'));
    await expect(expectFormContract(page('none'))).rejects.toThrow('leaveGuard: a changed page asks');
});

test('the focus probe fails a form that opens with nothing focused, or with a lone name not selected', async () => {
    await expectProbeToFail(
        'focus',
        shell({ onOpenAutoFocus: (event) => event.preventDefault() }),
        'Name has the focus',
    );
    const focusOnly = (event: Event) => {
        event.preventDefault();
        if (event.target instanceof Element) event.target.querySelector<HTMLElement>('input')?.focus();
    };
    await expectProbeToFail('focus', shell({ onOpenAutoFocus: focusOnly }), 'the text of Name is selected');
});

test('the Enter probe fails a field that swallows Enter, a form that submits twice, and a choice that ignores it', async () => {
    const swallow = (event: ReactKeyboardEvent) => event.key === 'Enter' && event.preventDefault();
    await expectProbeToFail('enter', shell({ onNameKeyDown: swallow }), 'Enter in Name submits, ran 0 times');
    await expectProbeToFail('enter', loose(), 'a second Enter while the first runs submits nothing, ran 2 times');
    const stop = (event: ReactKeyboardEvent) => event.stopPropagation();
    await expectProbeToFail('enter', shell({ onChoiceKeyDown: stop }), 'Enter on Keep a copy submits, ran 0 times');
});

test('the Cmd+Enter probe fails a form without it, and one that loses Ctrl+Enter', async () => {
    await expectProbeToFail('modEnter', loose({ guarded: true }), 'Cmd+Enter in Name submits, ran 0 times');
    const stopCtrl = (event: ReactKeyboardEvent) => event.ctrlKey && event.stopPropagation();
    await expectProbeToFail('modEnter', shell({ onNameKeyDown: stopCtrl }), 'Ctrl+Enter in Name submits, ran 0 times');
});

// The fields Cmd+Enter is pressed in beyond the name: a multi-line one, a rich-text one, and a time that it commits on
// Enter into the form's state.
function ModEnterFields({ breaksLine = false }: { breaksLine?: boolean }) {
    const [, setTime] = useState('09:00');
    return [
        createElement('textarea', {
            key: 'notes',
            'aria-label': 'Notes',
            defaultValue: 'One',
            onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                if (breaksLine && event.key === 'Enter') event.currentTarget.value += '\n';
            },
        }),
        createElement('div', { key: 'about', 'aria-label': 'About', contentEditable: true }, 'Two'),
        createElement('input', {
            key: 'start',
            'aria-label': 'Start',
            defaultValue: '09:00',
            onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter') setTime(event.currentTarget.value);
            },
        }),
    ];
}

const withFields = (breaksLine: boolean): FormContract => ({
    ...shell({ extra: createElement(ModEnterFields, { key: 'fields', breaksLine }) }),
    modEnterFields: ['Notes', 'About', 'Start'],
});

test('the Cmd+Enter probe presses in every field it is given, and fails one that adds a line break', async () => {
    await expectFormProbe('modEnter', withFields(false));
    await expectProbeToFail('modEnter', withFields(true), 'Cmd+Enter in Notes leaves its content as it was');
});

test('the Cmd+Enter probe fails a form that lets the key reach a hotkey behind it', async () => {
    await expectProbeToFail(
        'modEnter',
        loose({ guarded: true, modEnter: true }),
        'Cmd+Enter in Name reaches no hotkey behind the form',
    );
});

test('a form skips a probe it breaks on purpose, and only with a reason', async () => {
    const swallow = (event: ReactKeyboardEvent) => event.key === 'Enter' && !event.metaKey && event.preventDefault();
    const subject = shell({ onNameKeyDown: swallow });
    await expectProbeToFail('enter', subject, 'Enter in Name submits, ran 0 times');
    await expectFormContract({ ...subject, except: { enter: 'plain Enter in a subject must not send an email' } });
    await expect(expectFormContract({ ...subject, except: { enter: ' ' } })).rejects.toThrow(
        'enter: an exception says why',
    );
});

test('the close probe fails a dialog that ignores Esc, has no X, ignores a click outside, or whose Cancel stays', async () => {
    const keep = (event: Event) => event.preventDefault();
    await expectProbeToFail('close', loose({ content: { onEscapeKeyDown: keep } }), 'Esc closes');
    await expectProbeToFail('close', loose({ content: { showCloseButton: false } }), 'nothing to click');
    await expectProbeToFail('close', loose({ content: { onPointerDownOutside: keep } }), 'a click outside closes');
    await expectProbeToFail('close', loose({ cancelCloses: false }), 'Cancel closes the form');
});

test('the discard probe fails a form that never tells its shell it changed, and one that closes on a changed Esc', async () => {
    await expectProbeToFail(
        'discard',
        shell({ reportsChange: false }),
        'Esc on a changed form asks "Discard changes?"',
    );
    await expectProbeToFail('discard', loose(), 'Esc on a changed form asks "Discard changes?"');
});

test('the card Esc probe fails a card whose Esc closes it where Cancel goes back to its view', async () => {
    await expectProbeToFail('cardEsc', card(false), 'Esc with nothing changed does what Cancel does');
});

test('a form whose submit writes at once skips the pending probes', async () => {
    const subject = shell({ writesAtOnce: true });
    await expectProbeToFail('pending', subject, 'Save says it is busy while the save runs');
    await expectFormContract({ ...subject, savesAtOnce: true });
});

test('a page with no draft to lose skips the leave guard probe', async () => {
    await expectFormContract({ ...page('none'), noDraft: true });
});

test('the leave guard probe fails a changed page that leaves without asking', async () => {
    await expectProbeToFail('leaveGuard', page('none'), 'a changed page asks "Discard changes?"');
});

test('the leave guard probe fails a page that stands down while its save runs', async () => {
    await expectProbeToFail('leaveGuard', page('idle'), 'a changed page asks while its save runs');
});

test('the invalid probe fails a form that saves an invalid value, says nothing, or leaves its bad field unfocused', async () => {
    const unchecked = contract('dialog', (onSubmit) =>
        createElement(FormDialog, {
            open: true,
            onOpenChange: () => {},
            title: 'Rename',
            children: createElement(FormDialogForm, {
                changed: false,
                submitLabel: 'Save',
                onSubmit: () => onSubmit(''),
                children: createElement(Input, { 'aria-label': 'Name', defaultValue: 'Notes' }),
            }),
        }),
    );
    await expectProbeToFail('invalid', unchecked, 'an invalid form saves nothing, ran 1 times');
    await expectProbeToFail('invalid', shell({ showsError: false }), 'a message under Name says what is wrong');
    await expectProbeToFail('invalid', loose(), 'Name has the focus');
});

test('the pending probe fails a Save that hides that it is busy, or that saves again on a click or Cmd+Enter', async () => {
    await expectProbeToFail('pending', loose({ guarded: true }), 'Save says it is busy while the save runs');
    await expectProbeToFail('pending', loose({ busy: true }), 'a click while the save runs saves nothing more');
    await expectProbeToFail('pending', page('none', false), 'Cmd+Enter while the save runs saves nothing more, ran 2');
});

test('the pending close probe fails a dialog that closes while its save runs, or on a failed save', async () => {
    await expectProbeToFail('pendingClose', loose({ guarded: true, busy: true }), 'Esc while the save runs leaves');
    await expectFormProbe('pendingClose', loose({ guarded: true, waits: true }));
    await expectProbeToFail(
        'pendingClose',
        loose({ guarded: true, waits: true, closesOnFailure: true }),
        'a failed save keeps the form open',
    );
});
