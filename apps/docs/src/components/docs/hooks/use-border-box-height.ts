// The height an element draws at, its border box's, measured as it mounts and again whenever that box resizes. It is for
// a height only the drawn element knows, such as an auto text box's, which its grips start from and its panel shows.

import { useLayoutEffect, useState } from 'react';

// The border box, because a box drawn at a fixed width with `box-sizing: border-box` keeps its content box when its
// padding or its line grows. While `paused` the last height stays, and the pause's end measures again. None before an
// element is measured.
export function useBorderBoxHeight(element: HTMLElement | null, paused = false): number | undefined {
    const [height, setHeight] = useState<number>();
    useLayoutEffect(() => {
        if (!element || paused) return;
        setHeight(element.offsetHeight);
        const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
        observer.observe(element, { box: 'border-box' });
        return () => observer.disconnect();
    }, [element, paused]);
    return height;
}
