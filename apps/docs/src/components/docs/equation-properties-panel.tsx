import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { type Editor, useEditorState } from '@tiptap/react';
import { equationMath, parseMathml, readEquation } from '@workspace/lib/docs/eigendoc';
import {
    LATEX_COMMANDS,
    MathError,
    type MathRow,
    type MathXmlElement,
    readLatex,
    readMathml,
    readMathmlLatex,
    writeLatex,
    writeMathml,
} from '@workspace/math';
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
import { type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EQUATION_MENUS } from './equation-menus';
import { drawnMath, MathMount } from './extensions/equation';

type Read =
    | { mathml: string; row: MathRow; error?: undefined }
    | { mathml?: undefined; row?: undefined; error: MathError };

// A MathML draft's own LaTeX when the LaTeX reader takes it, as a paste keeps it, else its tree's.
function latexOf(math: MathXmlElement, row: MathRow): string {
    try {
        const latex = readMathmlLatex(math);
        if (latex !== undefined) readLatex(latex);
        return latex ?? writeLatex(row);
    } catch (error) {
        if (!(error instanceof MathError)) throw error;
        return writeLatex(row);
    }
}

// The MathML a draft commits as, its LaTeX the annotation, or where the reader stopped. A draft that starts with <math
// is MathML, parsed as the stored attr is.
function readDraft(draft: string): Read {
    try {
        const source = draft.trim();
        if (!source.startsWith('<math')) {
            const row = readLatex(draft);
            return { mathml: writeMathml(row, draft), row };
        }
        const math = parseMathml(source);
        if (!math) throw new MathError("This MathML can't be read");
        const row = readMathml(math);
        return { mathml: writeMathml(row, latexOf(math, row)), row };
    } catch (error) {
        if (!(error instanceof MathError)) throw error;
        return { error };
    }
}

// `\name` and a space typed after it become `\name{}{}`, a pair of braces per argument of the command, the caret in
// the first; a command whose arguments already follow keeps its space.
function expandCommand(previous: string, next: string, caret: number): { text: string; caret: number } | null {
    if (next[caret - 1] !== ' ' || next.slice(0, caret - 1) + next.slice(caret) !== previous) return null;
    if (next[caret] === '{' || next[caret] === '[') return null;
    const name = /\\([a-zA-Z]+) $/.exec(next.slice(0, caret))?.[1];
    const command = name === undefined ? undefined : LATEX_COMMANDS.get(name);
    if (!command || command.arguments === 0) return null;
    const braces = '{}'.repeat(command.arguments);
    return { text: next.slice(0, caret - 1) + braces + next.slice(caret), caret };
}

// The equation the panel shows, the last the selection holds, as getAttributes reads it.
function shownEquation({ doc, selection }: EditorState): { node: ProseMirrorNode; pos: number } | null {
    let shown: { node: ProseMirrorNode; pos: number } | null = null;
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
        if (node.type.name === 'equation') shown = { node, pos };
    });
    return shown;
}

// The draft around where the reader stopped, that character marked. The field's description, not an alert: half-typed
// LaTeX is an error at nearly every keystroke.
function ErrorAt({ id, text, error }: { id: string; text: string; error: MathError }) {
    const at = Math.min(error.offset ?? text.length, text.length);
    const start = Math.max(0, at - 24);
    return (
        <div id={id} className="space-y-1 text-xs">
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

// The LaTeX field edits a draft that no peer sees. A keystroke or a menu item starts it; Enter or a blur out of the
// field and its menus writes it if it parses and differs from the LaTeX it started from, and Escape drops it. Until
// then the field shows the equation as stored, a peer's write too. A draft stays through a transaction that moves the
// equation, a collaborator typing above it, and through a peer's write to it, the last writer winning.
export function EquationPropertiesPanel({ editor, fieldRef }: EquationPropertiesPanelProps) {
    // useEditor re-renders on no transaction, and a write that keeps the equation selected fires no selectionUpdate.
    const { latex, stored, display } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const equation = readEquation(shownEquation(e.state)?.node.attrs ?? {});
            return {
                // An equation from Word carries no LaTeX, so the field starts from the tree's.
                latex: equation.latex ?? writeLatex(equation.row),
                stored: equation.row,
                display: equation.display,
            };
        },
    });
    const [draft, setDraftState] = useState<{ text: string; base: string } | null>(null);
    // The blur that follows a commit runs in the render before it, so it reads the draft here.
    const draftRef = useRef(draft);
    const setDraft = (next: { text: string; base: string } | null) => {
        draftRef.current = next;
        setDraftState(next);
    };
    const edit = (text: string) => setDraft({ text, base: draftRef.current?.base ?? latex });
    const caretRef = useRef<number | null>(null);
    // Open symbol menus hold the focus, and the draft stays until it comes back to the field.
    const menuOpenRef = useRef(false);

    const text = draft?.text ?? latex;
    const read = useMemo(() => readDraft(text), [text]);
    const errorId = useId();
    // A draft that doesn't parse previews the equation as it stands.
    const row = read.row ?? stored;
    const preview = useMemo(() => (row.length === 0 ? null : drawnMath({ row, display })), [row, display]);

    // An edit puts the caret where it typed, after React writes the field.
    useLayoutEffect(() => {
        if (caretRef.current === null) return;
        fieldRef.current?.setSelectionRange(caretRef.current, caretRef.current);
        caretRef.current = null;
    });

    // A draft is its equation's. A peer's write to that equation makes a new node where it stood; a node the document
    // already held is another equation, which a click or the delete of this one moved under the selection.
    useEffect(() => {
        let owner = shownEquation(editor.state);
        const onTransaction = ({ transaction }: { transaction: Transaction }) => {
            const next = shownEquation(editor.state);
            if (!next || next.node === owner?.node) return;
            let held = false;
            transaction.before.descendants((node) => {
                held ||= node === next.node;
                return !held;
            });
            if (held || next.pos !== owner?.pos) setDraft(null);
            owner = next;
        };
        editor.on('transaction', onTransaction);
        return () => {
            editor.off('transaction', onTransaction);
        };
    }, [editor]);

    // A draft that parses is written, to the equation shown alone, if it changed; one that doesn't stays, showing its
    // error, as does one whose write finds no equation.
    const commit = () => {
        const current = draftRef.current;
        if (current === null) return true;
        const { mathml } = readDraft(current.text);
        if (mathml === undefined) return false;
        if (current.text !== current.base) {
            const shown = shownEquation(editor.state);
            if (!shown) return false;
            editor.commands.command(({ tr }) => {
                tr.setNodeAttribute(shown.pos, 'mathml', mathml);
                return true;
            });
        }
        setDraft(null);
        return true;
    };
    // React fires no blur when the field unmounts, as the comments panel taking the slot or a phone's width does.
    const commitRef = useRef(commit);
    commitRef.current = commit;
    useEffect(() => () => void commitRef.current(), []);

    const insertAtCaret = ({ insert, caret }: { insert: string; caret: number }) => {
        const field = fieldRef.current;
        if (!field) return;
        const { selectionStart, selectionEnd, value } = field;
        edit(value.slice(0, selectionStart) + insert + value.slice(selectionEnd));
        caretRef.current = selectionStart + caret;
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
                                            aria-label={item.label}
                                            title={item.insert.trim()}
                                            className="h-8 w-8 justify-center p-0"
                                            onClick={() => insertAtCaret(item)}
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
                        aria-describedby={read.error && errorId}
                        className="min-h-14 font-mono text-xs md:text-xs"
                        placeholder="x^2"
                        spellCheck={false}
                        value={text}
                        onChange={(e) => {
                            const next = e.target.value;
                            const expanded = expandCommand(text, next, e.target.selectionStart);
                            if (expanded) caretRef.current = expanded.caret;
                            edit(expanded?.text ?? next);
                        }}
                        onKeyDown={(e) => {
                            if (e.nativeEvent.isComposing) return;
                            if (e.key === 'Escape') setDraft(null);
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            const after = editor.state.selection.to;
                            if (commit()) editor.chain().focus().setTextSelection(after).run();
                        }}
                    />
                    {read.error && <ErrorAt id={errorId} text={text} error={read.error} />}
                </div>
            </PropertySection>
        </PropertiesPanel>
    );
}
