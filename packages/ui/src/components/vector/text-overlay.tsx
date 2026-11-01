// The editor of an arrow label: a plain <textarea> placed over the label through the viewport transform and styled
// like the SVG <text> it becomes. A label is a plain string, so a rich-text editor would let HTML into it. A session
// commits exactly once, on Escape, a click elsewhere, blur or unmount, and the host decides what the text becomes.
// Enter inserts a newline, and the textarea's own undo covers the session.

import { getFontFamily } from '@workspace/lib/constants/fonts';
import type { Box, TextAlign } from '@workspace/lib/vector';
import { getLineHeightPx, labelText, MAX_ARROW_LABEL_BYTES } from '@workspace/lib/vector';
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

    // Commit what the READER keeps: labelText caps bytes (not UTF-16 units) and lines, so the stored
    // label is never longer than what every peer's read, render and export will show.
    const commit = useCallback(() => {
        if (committedRef.current) return;
        committedRef.current = true;
        onCommit(labelText(valueRef.current));
    }, [onCommit]);

    // Unmount commits (the latch makes it a no-op after any normal commit): a route change or a
    // connection drop swapping the editor to its loading state must not silently drop the session's
    // text. Via ref so a mid-session onCommit identity change can't fire it. (No StrictMode anywhere
    // in Eigen — a simulated unmount would trip this latch and dead-lock the session if that changes.)
    const commitRef = useRef(commit);
    commitRef.current = commit;
    useEffect(() => () => commitRef.current(), []);

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

    // A face loads only the unicode-range slices its text needs. So the overlay loads the slices of its text as it
    // opens and as the user types, before the host measures the label at commit. Once they swap in, the box grows
    // again to fit the real metrics rather than the fallback's. An empty text matches no slice, so a fresh label
    // loads the slice with the space.
    const loadFont = (text: string) => {
        loadVectorFont(fontSize, fontFamily, text || ' ')
            .then(grow)
            .catch(() => {});
    };
    useEffect(() => loadFont(valueRef.current), [fontSize, fontFamily]);

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
            // Coarse DOM-side guard against a pathological paste — UTF-16 units, so it is always looser
            // than the reader's byte budget. commit() is what actually caps.
            maxLength={MAX_ARROW_LABEL_BYTES}
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
                loadFont(valueRef.current);
            }}
            onKeyDown={(e) => {
                // Escape stops here, so the canvas doesn't also deselect. While an IME composes, Escape cancels the
                // composition, not the session.
                if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.stopPropagation();
                    commit();
                }
            }}
            onBlur={commit}
        />
    );
}
