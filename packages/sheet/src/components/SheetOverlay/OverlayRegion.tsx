import type React from 'react';
import { useContext, useEffect, useRef } from 'react';
import { WorkbookContext } from '../../context';
import type { OverlayRegionSpec } from '../../state';

type Props = Omit<OverlayRegionSpec, 'pane'> & {
    children: React.ReactNode;
};

// One pane viewport inside the body-overlay layer (see RENDERING.md
// § Scrolling). The outer div sits at a fixed viewport rect and clips;
// the content div restores the content-coordinate origin (offset back by
// -left/-top) and translates from the scroll bus on its free axes, pinning a
// frozen axis to the freeze-time scroll — the header transform pattern
// generalized per pane. pointer-events none keeps the sized rect from
// shadowing hit-testing: interactive overlay children re-enable themselves
// with pointer-events auto, everything else falls through to the cell area.
export function OverlayRegion({ left, top, width, height, clip, fixedLeft, fixedTop, children }: Props) {
    const { refs } = useContext(WorkbookContext);
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const applyOffset = () => {
            if (contentRef.current) {
                const x = fixedLeft ?? refs.globalCache.scrollLeft;
                const y = fixedTop ?? refs.globalCache.scrollTop;
                contentRef.current.style.transform = `translate(${-x}px, ${-y}px)`;
            }
        };
        applyOffset();
        refs.globalCache.scrollListeners.add(applyOffset);
        return () => {
            refs.globalCache.scrollListeners.delete(applyOffset);
        };
    }, [refs.globalCache, fixedLeft, fixedTop]);

    return (
        <div
            style={{
                position: 'absolute',
                left,
                top,
                width,
                height,
                overflow: clip ? 'hidden' : 'visible',
                pointerEvents: 'none',
            }}
        >
            <div ref={contentRef} style={{ position: 'absolute', left: -left, top: -top, width: 0, height: 0 }}>
                {children}
            </div>
        </div>
    );
}
