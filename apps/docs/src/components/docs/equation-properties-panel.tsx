import { type Editor, useEditorState } from '@tiptap/react';
import { equationMath, readEquation } from '@workspace/lib/docs/eigendoc';
import { LATEX_COMMANDS, MathError, readLatex, writeLatex, writeMathml } from '@workspace/math';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {
    PropertiesPanel,
    PropertyRow,
    PropertySection,
    PropertyToggle,
} from '@workspace/ui/components/properties-panel';
import { Textarea } from '@workspace/ui/components/textarea';
import { Rows3 } from 'lucide-react';
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EQUATION_MENUS } from './equation-menus';
import { MathMount } from './extensions/equation';

type Read = { mathml: string; empty: boolean; error?: undefined } | { mathml?: undefined; error: MathError };

// The MathML a draft commits as, its LaTeX the annotation, or where the reader stopped.
function readDraft(latex: string): Read {
    try {
        const row = readLatex(latex);
        return { mathml: writeMathml(row, latex), empty: row.length === 0 };
    } catch (error) {
        if (!(error instanceof MathError)) throw error;
        return { error };
    }
}

// `\name` and a space typed after it become `\name{}{}`, a pair of braces per argument of the command.
function expandCommand(previous: string, next: string, caret: number): { text: string; caret: number } | null {
    if (next[caret - 1] !== ' ' || next.slice(0, caret - 1) + next.slice(caret) !== previous) return null;
    const name = /\\([a-zA-Z]+) $/.exec(next.slice(0, caret))?.[1];
    const command = name === undefined ? undefined : LATEX_COMMANDS.get(name);
    if (!command || command.arguments === 0) return null;
    const braces = '{}'.repeat(command.arguments);
    return { text: next.slice(0, caret - 1) + braces + next.slice(caret), caret: caret - 1 + braces.length };
}

// The draft around where the reader stopped, that character marked.
function ErrorAt({ text, error }: { text: string; error: MathError }) {
    const at = Math.min(error.offset ?? text.length, text.length);
    const start = Math.max(0, at - 24);
    return (
        <div role="alert" className="space-y-1 text-xs">
            <p className="text-destructive">{error.message}</p>
            <p className="font-mono break-all text-muted-foreground">
                {start > 0 && '…'}
                {text.slice(start, at)}
                <span className="text-destructive underline decoration-wavy">{text[at] ?? ' '}</span>
                {text.slice(at + 1, at + 24)}
                {at + 24 < text.length && '…'}
            </p>
        </div>
    );
}

function SymbolCell({ preview }: { preview: string }) {
    const math = useMemo(() => equationMath({ mathml: writeMathml(readLatex(preview)), display: false }), [preview]);
    return <MathMount math={math} />;
}

type EquationPropertiesPanelProps = {
    editor: Editor;
    fieldRef: RefObject<HTMLTextAreaElement | null>;
};

// The LaTeX field edits a draft that no peer sees: Enter or a blur out of the field and its menus writes it, if it
// parses, and Escape drops it. While it has focus it shows its draft, so a transaction that moves the equation, a
// collaborator typing above it, neither resets nor blurs it.
export function EquationPropertiesPanel({ editor, fieldRef }: EquationPropertiesPanelProps) {
    // useEditor re-renders on no transaction, and a write that keeps the equation selected fires no selectionUpdate.
    const { latex, mathml, empty, display, from } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const equation = readEquation(e.getAttributes('equation'));
            return {
                // An equation from Word carries no LaTeX, so the field starts from the tree's.
                latex: equation.latex ?? writeLatex(equation.row),
                mathml: equation.mathml,
                empty: equation.row.length === 0,
                display: equation.display,
                from: e.state.selection.from,
            };
        },
    });
    const [draft, setDraftState] = useState<string | null>(null);
    // The blur that follows a commit runs in the render before it, so it reads the draft here.
    const draftRef = useRef(draft);
    const setDraft = (next: string | null) => {
        draftRef.current = next;
        setDraftState(next);
    };
    const caretRef = useRef<number | null>(null);
    // Open symbol menus hold the focus, and the draft stays until it comes back to the field.
    const menuOpenRef = useRef(false);

    const text = draft ?? latex;
    const read = useMemo(() => readDraft(text), [text]);
    // A draft that doesn't parse previews the equation as it stands.
    const shown = read.error ? { mathml, empty } : read;
    const preview = useMemo(
        () => (shown.empty ? null : equationMath({ mathml: shown.mathml, display })),
        [shown.mathml, shown.empty, display],
    );

    // An edit puts the caret where it typed, after React writes the field.
    useLayoutEffect(() => {
        if (caretRef.current === null) return;
        fieldRef.current?.setSelectionRange(caretRef.current, caretRef.current);
        caretRef.current = null;
    });

    // A draft left behind on another equation is not this one's.
    useEffect(() => {
        if (document.activeElement !== fieldRef.current) setDraft(null);
    }, [from]);

    // A draft that parses is written if it changed; one that doesn't stays, showing its error.
    const commit = () => {
        const current = draftRef.current;
        if (current === null) return true;
        const { mathml } = readDraft(current);
        if (mathml === undefined) return false;
        if (current !== latex) editor.commands.updateEquation({ mathml });
        setDraft(null);
        return true;
    };

    const insertAtCaret = (insert: string) => {
        const field = fieldRef.current;
        if (!field) return;
        const { selectionStart, selectionEnd, value } = field;
        setDraft(value.slice(0, selectionStart) + insert + value.slice(selectionEnd));
        caretRef.current = selectionStart + insert.length;
    };

    return (
        <PropertiesPanel title="Equation">
            <div className="app-gutter border-b">
                <div className="rounded border min-h-12 flex items-center justify-center overflow-x-auto p-2">
                    {preview ? (
                        <MathMount math={preview} />
                    ) : (
                        <span className="equation-placeholder" role="img" aria-label="Empty equation" />
                    )}
                </div>
            </div>

            <PropertySection title="Layout">
                <PropertyRow label="Display">
                    <PropertyToggle
                        aria-label="Display on its own line"
                        title="Display on its own line"
                        pressed={display}
                        onPressedChange={(pressed) => editor.commands.updateEquation({ display: pressed })}
                    >
                        <Rows3 className="h-4 w-4" />
                    </PropertyToggle>
                </PropertyRow>
            </PropertySection>

            <PropertySection title="LaTeX">
                <div
                    className="space-y-2"
                    onBlur={(e) => {
                        if (menuOpenRef.current) return;
                        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
                        commit();
                    }}
                >
                    <div className="flex items-center gap-1">
                        {EQUATION_MENUS.map((menu) => (
                            <DropdownMenu
                                key={menu.label}
                                onOpenChange={(open) => {
                                    if (open) menuOpenRef.current = true;
                                }}
                            >
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 w-7 px-0 text-base"
                                        aria-label={menu.label}
                                        title={menu.label}
                                    >
                                        {menu.glyph}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="start"
                                    className="grid grid-cols-6 gap-0.5 p-1"
                                    // Back to the field, at the caret an item left.
                                    onCloseAutoFocus={(e) => {
                                        e.preventDefault();
                                        menuOpenRef.current = false;
                                        fieldRef.current?.focus();
                                    }}
                                >
                                    {menu.items.map((item) => (
                                        <DropdownMenuItem
                                            key={item.name}
                                            aria-label={item.name}
                                            title={item.insert.trim()}
                                            className="h-8 w-8 justify-center p-0"
                                            onClick={() => insertAtCaret(item.insert)}
                                        >
                                            <SymbolCell preview={item.preview} />
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        ))}
                    </div>
                    <Textarea
                        ref={fieldRef}
                        aria-label="LaTeX"
                        aria-invalid={read.error !== undefined}
                        className="min-h-14 font-mono text-xs md:text-xs"
                        placeholder="x^2"
                        spellCheck={false}
                        value={text}
                        onFocus={() => {
                            if (draftRef.current === null) setDraft(latex);
                        }}
                        onChange={(e) => {
                            const next = e.target.value;
                            const expanded = expandCommand(text, next, e.target.selectionStart);
                            if (expanded) caretRef.current = expanded.caret;
                            setDraft(expanded?.text ?? next);
                        }}
                        onKeyDown={(e) => {
                            if (e.nativeEvent.isComposing) return;
                            if (e.key === 'Escape') setDraft(null);
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            const pos = editor.state.selection.from;
                            if (commit())
                                editor
                                    .chain()
                                    .focus()
                                    .setTextSelection(pos + 1)
                                    .run();
                        }}
                    />
                    {read.error && <ErrorAt text={text} error={read.error} />}
                </div>
            </PropertySection>
        </PropertiesPanel>
    );
}
