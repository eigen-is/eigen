// The in-canvas text editor: a raw <textarea> (not shadcn — its border/ring/min-height are wrong
// for a canvas overlay) absolutely positioned over the element via the viewport transform, styled
// so WYSIWYG holds against the committed SVG <text>. §A `text` is a PLAIN string with \n, so a
// contentEditable/Tiptap surface would smuggle HTML into a plain-string field — a textarea is
// Excalidraw's own choice and the correct one here.
//
// Commit-once latch (audited against UX risk #1 — double-handling): exactly one commit per
// session, or zero for an empty new element. Escape commits (claimed here via onKeyDown +
// stopPropagation so the canvas's Escape-deselect never also fires); click-away commits and the
// click is swallowed (a capture-phase document pointerdown: commit + stopPropagation so the
// committing click can't also marquee/deselect/place); blur is the alt-tab fallback. Enter inserts
// a newline (never commits). The textarea is uncontrolled so its native ⌘Z owns in-session undo.

import { getFontFamily } from '@workspace/lib/constants/fonts';
import { type Box, getLineHeightPx, type TextAlign } from '@workspace/lib/vector';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { loadVectorFont } from './text-measure';

type TextOverlayProps = {
    // Element top-left + box in scene units (box drives the rotation origin).
    x: number;
    y: number;
    width: number;
    height: number;
    angle: number;
    zoom: number;
    // The canvas container — a click-away inside it commits AND is swallowed (never marquee/place);
    // a click-away outside it (properties panel, toolbar) commits but is left untouched so the
    // control receives its first click.
    containerRef: React.RefObject<HTMLElement | null>;
    // Host positioning of the overlay: reuses the canvas's boxToStyle for container-px left/top.
    boxToStyle: (box: Box) => React.CSSProperties;
    initialText: string;
    fontSize: number;
    fontFamily: string;
    textAlign: TextAlign;
    color: string;
    // Fires exactly once with the final text; the host decides add/update/delete and re-measures.
    onCommit: (text: string) => void;
};

export function TextOverlay({
    x,
    y,
    width,
    height,
    angle,
    zoom,
    containerRef,
    boxToStyle,
    initialText,
    fontSize,
    fontFamily,
    textAlign,
    color,
    onCommit,
}: TextOverlayProps) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    // Latest textarea value — the textarea is uncontrolled (native undo), so read it from here.
    const valueRef = useRef(initialText);
    const committedRef = useRef(false);

    const commit = useCallback(() => {
        if (committedRef.current) return;
        committedRef.current = true;
        onCommit(valueRef.current);
    }, [onCommit]);

    // Grow snugly to content (wrap="off" → widest line drives width). scrollWidth/scrollHeight are
    // fine for the live editing box; the STORED dims come from the canvas measurement util, never here.
    const grow = () => {
        const ta = taRef.current;
        if (!ta) return;
        ta.style.width = '0px';
        ta.style.width = `${ta.scrollWidth + 2}px`; // +2 leaves room for the caret at line end
        ta.style.height = '0px';
        ta.style.height = `${ta.scrollHeight}px`;
    };

    useLayoutEffect(() => {
        const ta = taRef.current;
        if (!ta) return;
        grow();
        ta.focus();
        // Canvas-label convention (Excalidraw/Figma/tldraw): editing an existing element selects
        // all so the first keystroke replaces; a fresh element just gets the caret.
        if (initialText) ta.select();
        else ta.setSelectionRange(0, 0);
    }, []);

    // Ensure the face is registered before the user commits (measurement needs it); re-grow once it
    // swaps in so the box fits the real metrics rather than the fallback font.
    useEffect(() => {
        loadVectorFont(fontSize, fontFamily)
            .then(grow)
            .catch(() => {});
    }, [fontSize, fontFamily]);

    // Click-away commit — capture phase so it runs before the canvas's React pointerdown. Clicks
    // inside the textarea (caret moves) pass through. A click elsewhere on the CANVAS commits and is
    // swallowed (never marquee/deselect/place). A click on the surrounding chrome (properties panel,
    // toolbar) commits the session but is left untouched, so that control gets its first click
    // instead of a dead one — and the session is committed before any panel write lands on it.
    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            const ta = taRef.current;
            if (ta && (e.target === ta || ta.contains(e.target as Node))) return;
            const container = containerRef.current;
            if (container?.contains(e.target as Node)) {
                e.preventDefault();
                e.stopPropagation();
            }
            commit();
        };
        document.addEventListener('pointerdown', onPointerDown, { capture: true });
        return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    }, [commit, containerRef]);

    const pos = boxToStyle({ x, y, width, height, angle });
    const lineHeightPx = getLineHeightPx(fontFamily, fontSize) * zoom;

    return (
        <textarea
            ref={taRef}
            defaultValue={initialText}
            wrap="off"
            spellCheck={false}
            className="pointer-events-auto absolute"
            style={{
                left: pos.left,
                top: pos.top,
                transform: angle ? `rotate(${angle}deg)` : undefined,
                // Rotate about the element center (matches the SVG's rotate-about-center), expressed
                // in the textarea's local px frame; new/unrotated text has a 0,0 box so this is inert.
                transformOrigin: `${(width * zoom) / 2}px ${(height * zoom) / 2}px`,
                boxSizing: 'content-box',
                margin: 0,
                padding: 0,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                resize: 'none',
                overflow: 'hidden',
                whiteSpace: 'pre',
                color,
                fontFamily: getFontFamily(fontFamily),
                fontSize: `${fontSize * zoom}px`,
                lineHeight: `${lineHeightPx}px`,
                fontWeight: 400,
                textAlign,
                minWidth: '1px',
            }}
            onInput={(e) => {
                valueRef.current = e.currentTarget.value;
                grow();
            }}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    commit();
                }
            }}
            onBlur={commit}
        />
    );
}
