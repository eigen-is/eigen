import { type Box, paintsNothing, type VectorElement } from '@workspace/lib/vector';
import { memo } from 'react';
import { elementBox } from './tools/boxes';

type EmptyOutlinesProps = {
    elements: VectorElement[];
    boxToStyle: (box: Box) => React.CSSProperties;
};

// An element that paints nothing — an empty text box, a shape with neither fill nor border, an image
// with no picture — is invisible on the page but entirely real: it can be selected, filled in, moved.
// While editing, the canvas rings each one faintly so it can still be found. Screen-space CHROME, never
// the layer: a thumbnail, present mode, a preview and an export show the page exactly as it is.
// Memoized: both props are stable across the renders a selection or a preview causes, so the scan
// (which strips tags to answer "is this box empty") runs only when the scene or the viewport moves.
export const EmptyOutlines = memo(function EmptyOutlines({ elements, boxToStyle }: EmptyOutlinesProps) {
    return (
        <>
            {elements.filter(paintsNothing).map((el) => (
                <div
                    key={el.id}
                    className="eigen-empty-outline pointer-events-none absolute"
                    style={{
                        ...boxToStyle(elementBox(el)),
                        transform: el.angle ? `rotate(${el.angle}deg)` : undefined,
                    }}
                />
            ))}
        </>
    );
});
