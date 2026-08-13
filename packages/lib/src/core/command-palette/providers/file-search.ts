import { getDriveItemUrl } from '@workspace/lib/api';
import type { CommandContext, PaletteResult, PaletteScope } from '@workspace/lib/types/command-palette';
import { isCollabType, stripEigenExtension } from '@workspace/lib/types/drive';
import { useMemo } from 'react';
import { getFilePresentation } from '../../file-presentation';
import { useSearch } from '../../search';
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

    // Skip the network call when the effective scope excludes files.
    const scopeBlocks = scope === 'mail' || scope === 'actions' || scope === 'contacts' || scope === 'doc';

    const { data, isFetching } = useSearch({
        ownerId: ctx.ownerId,
        q: parsed.q,
        sources: ['file'],
        limit: 6,
        // Include the caller's team drives in palette file hits (server-side fan-out).
        teams: '1',
        enabled: !scopeBlocks && parsed.q.length > 0,
    });

    const results = useMemo<PaletteResult[]>(() => {
        if (!data) return [];
        // Carry the query into the opened document so its find bar lands on the matches.
        const encodedQ = parsed.q ? encodeURIComponent(parsed.q) : '';
        return data.file.map((path, i) => {
            const presentation = getFilePresentation(path.mimeType, path.type);
            // Only the four eigendoc editors consume ?q= — chat/folder/inline-edit URLs never do.
            const carryQ = encodedQ && isCollabType(path.type) ? encodedQ : '';
            return {
                kind: 'file' as const,
                id: `file.${path.id}`,
                title: stripEigenExtension(path.name),
                icon: presentation.icon,
                group: 'file',
                rank: -i,
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
        });
    }, [data, parsed.q]);

    const willSearch = !scopeBlocks && parsed.q.length > 0;
    const isDebouncing = !scopeBlocks && input.trim().length > 0 && input !== debouncedInput;
    return { results, isPending: (willSearch && isFetching) || isDebouncing };
}
