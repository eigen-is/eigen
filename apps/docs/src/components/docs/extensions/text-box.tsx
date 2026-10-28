// The Docs editor's text box: the shared node with a view that draws it in the figure's frame, its paragraphs as static
// HTML or, while it is the open story, the box's live editor in their place, so the box keeps its size and place while
// it is typed in. A press on its text opens it; one on its edge band selects, moves or drags it, and its grips resize it
// with its height as a minimum. The editor component provides the open story through TextBoxContext.

import { Editor } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { NodeViewProps, NodeViewRendererProps } from '@tiptap/react';
import { EditorContent, ReactNodeView, ReactNodeViewRenderer } from '@tiptap/react';
import {
    isPositioned,
    readTextBoxAttrs,
    TEXT_BOX_MIN_SIDE,
    TextBoxNode,
    textBoxHTMLAttributes,
} from '@workspace/lib/docs/eigendoc';
import type { Box } from '@workspace/lib/vector';
import type React from 'react';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StaticStory } from '../footnote-list';
import type { FigureFrameOptions } from './figure-frame';
import { FigureFrame, figureFramePlugins, figureMaxWidth, useFigureResize } from './figure-frame';
import { behindFigureAt } from './positioned-figure';
import type { StoryAnchor } from './story';
import { drawsStory, registerStoryView } from './story';

export type TextBoxOptions = FigureFrameOptions & {
    // A press on a closed box's text, with where it landed, or Enter on a selected box; the body's editor only.
    onOpen: (pos: number, at: { left: number; top: number } | null) => void;
};

// The story the body's editor has open and the box's live editor, which the open box draws.
export const TextBoxContext = createContext<{ anchor: StoryAnchor | null; editor: Editor | null }>({
    anchor: null,
    editor: null,
});

const fitTextBox = (next: Box, maxWidth: number) => ({
    width: Math.round(Math.max(TEXT_BOX_MIN_SIDE, Math.min(maxWidth, next.width))),
    height: Math.round(Math.max(TEXT_BOX_MIN_SIDE, next.height)),
});

function TextBoxView(props: NodeViewProps) {
    const { node, selected, editor, getPos, extension } = props;
    const { onOpen }: TextBoxOptions = extension.options;
    const story = useContext(TextBoxContext);
    const attrs = useMemo(() => readTextBoxAttrs(node.attrs), [node.attrs]);
    const open = story.anchor && drawsStory(editor, story.anchor, node) ? story.editor : null;
    const isEditable = editor.isEditable;
    const boxRef = useRef<HTMLSpanElement>(null);
    // The box's drawn height, its text's or its minimum, which a grip starts from. A gesture that leaves it as it was
    // keeps the height as stored, so dragging the width of an auto box keeps it auto.
    const [drawnHeight, setDrawnHeight] = useState(0);
    const drawn = useRef(0);
    drawn.current = drawnHeight;

    const getMaxWidth = useCallback(() => figureMaxWidth(editor, attrs.layout), [editor, attrs.layout]);
    const stored = useCallback(
        ({ width, height }: { width: number; height: number }) =>
            height === drawn.current ? { width } : { width, height },
        [],
    );
    const resize = useFigureResize({ editor, getPos, node, getMaxWidth, fit: fitTextBox, stored });
    const preview = resize.preview?.size;

    // The look as every surface draws it, a grip's preview size in its place.
    useLayoutEffect(() => {
        const element = boxRef.current;
        if (!element) return;
        for (const name of element.getAttributeNames()) element.removeAttribute(name);
        const look = preview ? { ...attrs, ...preview } : attrs;
        for (const [name, value] of Object.entries(textBoxHTMLAttributes(look))) element.setAttribute(name, value);
        setDrawnHeight(element.offsetHeight);
    }, [attrs, preview, node, open]);

    // A delete and an insert of the node, such as a re-anchor, mounts the open editor in a new view, and the browser
    // drops the focus of the one it took away. Nothing else has taken it, so it goes back.
    useLayoutEffect(() => {
        const active = document.activeElement;
        if (open && (active === null || active === document.body)) open.view.focus();
    }, [open]);

    const openAt = (e: React.PointerEvent) => {
        const pos = getPos();
        if (pos === undefined) return;
        e.preventDefault();
        onOpen(pos, { left: e.clientX, top: e.clientY });
    };
    const box: Box | null =
        selected && isEditable && !open
            ? { x: 0, y: 0, width: preview?.width ?? attrs.width, height: preview?.height ?? drawnHeight, angle: 0 }
            : null;

    return (
        <FigureFrame
            {...props}
            box={box}
            shift={resize.preview?.shift}
            resizeMode="free"
            onTransform={resize.onTransform}
            onCommit={resize.onCommit}
            onGestureEnd={resize.onGestureEnd}
            label="Resize text box"
            dragSurface={{ onInsidePress: open || !isEditable ? null : openAt, text: boxRef }}
        >
            <span ref={boxRef}>
                {open ? (
                    <EditorContent editor={open} className="contents" data-story-editor="" />
                ) : (
                    <StaticStory node={node} className="contents" />
                )}
            </span>
        </FigureFrame>
    );
}

// The live editor a box draws while it is open, which TipTap names on its view's element.
function openEditorIn(dom: globalThis.Node | null): Editor | null {
    const element = dom instanceof Element ? dom.querySelector('[data-story-editor] .ProseMirror') : null;
    return element && 'editor' in element && element.editor instanceof Editor ? element.editor : null;
}

// Letters, digits and the underscore, which a double-click selects a run of.
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

// A press on an open box behind the text lands on the text's layer above it, so the browser never puts the box's
// selection down. Here the caret goes where it pressed and a drag selects on from there, and a double or a triple
// press selects the word or the paragraph.
function pressInto(story: EditorView, event: MouseEvent) {
    const at = ({ clientX, clientY }: MouseEvent) => story.posAtCoords({ left: clientX, top: clientY })?.pos;
    const anchor = at(event);
    if (anchor === undefined) return;
    const select = (from: number, to: number) =>
        story.dispatch(story.state.tr.setSelection(TextSelection.create(story.state.doc, from, to)));
    const $anchor = story.state.doc.resolve(anchor);
    story.focus();
    if (event.detail >= 3) select($anchor.start(), $anchor.end());
    else if (event.detail === 2) {
        const text = $anchor.parent.textBetween(0, $anchor.parent.content.size, undefined, ' ');
        let from = $anchor.parentOffset;
        let to = from;
        while (from > 0 && WORD_CHARACTER.test(text.charAt(from - 1))) from--;
        while (to < text.length && WORD_CHARACTER.test(text.charAt(to))) to++;
        select($anchor.start() + from, $anchor.start() + to);
    } else {
        select(anchor, anchor);
        const gesture = new AbortController();
        const { signal } = gesture;
        document.addEventListener(
            'mousemove',
            (move) => {
                const head = at(move);
                if (head !== undefined) select(anchor, head);
            },
            { signal },
        );
        document.addEventListener('mouseup', () => gesture.abort(), { signal });
    }
}

// No contentDOM: the box's paragraphs are its own editor's, never the body's DOM, as a note's are. Every event inside the
// open editor stays there, a drag of its text too, which TipTap would hand to the body.
class TextBoxNodeView extends ReactNodeView {
    public override get contentDOM() {
        return null;
    }

    public override stopEvent(event: Event): boolean {
        const { target } = event;
        if (target instanceof Element && target.closest('[data-story-editor]')) return true;
        return super.stopEvent(event);
    }
}

export const TextBox = TextBoxNode.extend<TextBoxOptions>({
    // Ahead of the positioned figures', so a press over a box behind the text opens it before their hit test selects it.
    priority: 1001,

    addOptions() {
        return { onContextMenu: () => {}, onOpenComment: () => {}, onOpen: () => {} };
    },

    addKeyboardShortcuts() {
        const selectedBox = () => {
            const { selection } = this.editor.state;
            return selection instanceof NodeSelection && selection.node.type.name === this.name ? selection : null;
        };
        return {
            // As Word's: Enter on a selected box puts the caret at the end of its text.
            Enter: () => {
                const selection = selectedBox();
                if (!selection || !this.editor.isEditable) return false;
                this.options.onOpen(selection.from, null);
                return true;
            },
            // A box in the flow leaves to the caret after it; one in front of or behind the text to its paragraph's
            // visual start, as the positioned figures' keys put it.
            Escape: () => {
                const selection = selectedBox();
                if (!selection || isPositioned(readTextBoxAttrs(selection.node.attrs).layout)) return false;
                return this.editor.commands.setTextSelection(selection.to);
            },
        };
    },

    addProseMirrorPlugins() {
        const { onOpen } = this.options;
        return [
            ...figureFramePlugins('textBox'),
            new Plugin({
                key: new PluginKey('behindTextBox'),
                props: {
                    handleDOMEvents: {
                        // A box behind the text opens where no text covers it, and once open takes the press
                        // there. Alt selects it, as the positioned figures' hit test does.
                        mousedown(view, event) {
                            if (event.button !== 0 || event.altKey || !view.editable) return false;
                            const pos = behindFigureAt(view, event.clientX, event.clientY, false);
                            if (pos === null || view.state.doc.nodeAt(pos)?.type.name !== 'textBox') return false;
                            event.preventDefault();
                            const story = openEditorIn(view.nodeDOM(pos));
                            if (story) pressInto(story.view, event);
                            else onOpen(pos, { left: event.clientX, top: event.clientY });
                            return true;
                        },
                    },
                },
            }),
        ];
    },

    addNodeView() {
        // TipTap skips the re-render when only decorations change, and the comment mark's color arrives as one.
        const options = {
            update: ({ updateProps }: { updateProps: () => void }) => {
                updateProps();
                return true;
            },
        };
        return (props: NodeViewRendererProps) => {
            if (!('contentComponent' in props.editor && props.editor.contentComponent))
                return ReactNodeViewRenderer(TextBoxView, options)(props);
            const view = new TextBoxNodeView(TextBoxView, props, options);
            // ReactNodeView made a content element for a node with content and put it in the view's DOM, where the
            // frame's geometry, such as the box a figure is measured by, would take it for the box.
            view.contentDOMElement?.remove();
            view.contentDOMElement = null;
            registerStoryView(view.dom, view);
            return view;
        };
    },
});
