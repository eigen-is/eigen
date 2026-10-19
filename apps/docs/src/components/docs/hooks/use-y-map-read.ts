import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

// A root map as its reader reads it, again on every change any peer makes. `read` takes `map.toJSON()`, a module's own
// function (readPageSetup, readNormalStyle), so the subscription stays across renders.
export function useYMapRead<T>(map: Y.Map<unknown>, read: (record: Record<string, unknown>) => T): T {
    const [value, setValue] = useState(() => read(map.toJSON()));
    useEffect(() => {
        const update = () => setValue(read(map.toJSON()));
        // A change between the first render and this subscription fires no event.
        update();
        map.observe(update);
        return () => map.unobserve(update);
    }, [map, read]);
    return value;
}
