import type { NormalStyle } from '@workspace/lib/docs/eigendoc';
import { readNormalStyle, STYLE_ROOT } from '@workspace/lib/docs/eigendoc';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

export function useNormalStyle(doc: Y.Doc): NormalStyle {
    const map = doc.getMap(STYLE_ROOT);
    const [style, setStyle] = useState(() => readNormalStyle(map.toJSON()));
    useEffect(() => {
        const read = () => setStyle(readNormalStyle(map.toJSON()));
        // A change between the first render and this subscription fires no event.
        read();
        map.observe(read);
        return () => map.unobserve(read);
    }, [map]);
    return style;
}
