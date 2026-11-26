// The draft of an admin page that edits settings it loaded, such as Server settings: the changes made so far, the
// values the page shows with them applied, the values as loaded, and whether the two differ. A value put back by hand
// reads as unchanged. The page's withDraft builds both sides, so each page decides how its draft merges.

import type { DeepPartial } from '@workspace/lib/types/util';
import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';

type PageDraft<Loaded, Shown> = {
    draft: DeepPartial<Loaded>;
    setDraft: Dispatch<SetStateAction<DeepPartial<Loaded>>>;
    current: Shown;
    loaded: Shown;
    changed: boolean;
    reset: () => void;
};

export function usePageDraft<Loaded, Shown>(
    loaded: Loaded,
    withDraft: (loaded: Loaded, draft: DeepPartial<Loaded>) => Shown,
): PageDraft<Loaded, Shown> {
    const [draft, setDraft] = useState<DeepPartial<Loaded>>({});
    const current = withDraft(loaded, draft);
    const shown = withDraft(loaded, {});
    return {
        draft,
        setDraft,
        current,
        loaded: shown,
        // Both sides are built the same way, so their keys come in the same order.
        changed: JSON.stringify(current) !== JSON.stringify(shown),
        reset: () => setDraft({}),
    };
}
