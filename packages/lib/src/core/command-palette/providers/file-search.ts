// The palette's Drive search: a debounced query to the search route for the files that match the typed text,
// across the caller's own and team drives. It also owns the one file row that recent files reuse.

import { getDriveItemUrl } from '@workspace/lib/api';
import type { CommandContext, PaletteResult, PaletteScope } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isCollabType, stripEigenExtension } from '@workspace/lib/types/drive';
import { useMemo } from 'react';
import { getFilePresentation } from '../../file-presentation';
import { useSearchQuery } from '../../search';
import { useDebouncedValue } from '../../use-debounced-value';
import { parseQuery } from '../parse-query';

// Same debounce as mail — short enough to feel live, long enough to coalesce typing.
const FILE_SEARCH_DEBOUNCE_MS = 150;

export function useFileSearchResults(
    ctx: CommandContext,
    input: string,
    scope: PaletteScope | undefined,
): {
    results: PaletteResult[];
    isPending: boolean;
} {
    const debouncedInput = useDebouncedValue(input, FILE_SEARCH_DEBOUNCE_MS);
    const parsed = parseQuery(debouncedInput);

    const scopeBlocks = !!scope && scope !== 'file';
    const enabled = !scopeBlocks && parsed.q.length > 0;

    const { data, isFetching } = useSearchQuery({
        ownerId: ctx.ownerId,
        q: parsed.q,
        sources: ['file'],
        limit: 6,
        // Include the caller's team drives in palette file hits (server-side fan-out).
        teams: '1',
        enabled,
    });

    const results = useMemo<PaletteResult[]>(
        () => (data ? data.file.map((path, i) => fileToResult(path, parsed.q, 'file', -i)) : []),
        [data, parsed.q],
    );

    const isDebouncing = !scopeBlocks && input.trim().length > 0 && input !== debouncedInput;
    return { results, isPending: (enabled && isFetching) || isDebouncing };
}

// One file row, for a search hit and a recent file alike, so both open the file the same way. The query rides
// along into the opened document so its find bar lands on the matches; only the collab editors read ?q=.
export function fileToResult(path: DrivePath, q: string, group: 'file' | 'recent', rank: number): PaletteResult {
    const carryQ = q && isCollabType(path.type) ? encodeURIComponent(q) : '';
    return {
        kind: 'file',
        id: `file.${path.id}`,
        title: stripEigenExtension(path.name),
        icon: getFilePresentation(path.mimeType, path.type, path.name).icon,
        group,
        rank,
        payload: path,
        run: (rctx) => {
            const url = getDriveItemUrl(path);
            if (!url) {
                rctx.openPreview(path);
                return;
            }
            rctx.navigate(carryQ ? `${url}${url.includes('?') ? '&' : '?'}q=${carryQ}` : url);
        },
    };
}
