import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { PAGE_ROOT, readPageSetup } from '@workspace/lib/docs/eigendoc';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

export function usePageSetup(doc: Y.Doc): PageSetup {
    const page = doc.getMap(PAGE_ROOT);
    const [setup, setSetup] = useState(() => readPageSetup(page.toJSON()));
    useEffect(() => {
        const read = () => setSetup(readPageSetup(page.toJSON()));
        // A change between the first render and this subscription fires no event.
        read();
        page.observe(read);
        return () => page.unobserve(read);
    }, [page]);
    return setup;
}
