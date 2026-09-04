import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

// The ?q= landing term for the in-document find bar, shared by the doc/slide/board/sheet routes. Latched once:
// the editors defer their subtree until collab sync, so the DocSearchProvider mounts long after the
// route resolves — a clear timed against the consumer's mount would race it and wipe q first.
// Latched, the URL strip is timing-proof (replace: true → no history entry; the link still works on
// the next visit). Latches per MOUNT: unreachable today (palette links full-reload via
// window.location.href), but if CommandContext.navigate ever goes through the router, latch per pathId.
//
// Its own module, not part of use-eigen-doc-editor-route: `useNavigate` is typed against the calling
// app's registered router, so only an app whose routes declare `?q=` can compile this hook.
export function useLatchedDocSearchTerm(q: string | undefined): string | undefined {
    const navigate = useNavigate();
    const [initialSearchTerm] = useState(q);
    useEffect(() => {
        if (q) {
            navigate({ to: '.', search: (prev: { q?: string }) => ({ ...prev, q: undefined }), replace: true });
        }
    }, [q, navigate]);
    return initialSearchTerm;
}
