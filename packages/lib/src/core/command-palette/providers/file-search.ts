import { getDriveItemUrl } from '@workspace/lib/api';
import type { CommandContext, PaletteResult, PaletteScope } from '@workspace/lib/types/command-palette';
import { isFolderType, stripEigenExtension } from '@workspace/lib/types/drive';
import { File, Folder, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import { EIGEN_DOC_ICONS } from '../../eigendoc-icons';
import { useSearch } from '../../search';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { parseQuery } from '../parse-query';

// Same debounce as mail — short enough to feel live, long enough to coalesce typing.
const FILE_SEARCH_DEBOUNCE_MS = 150;

function iconForPath(type: string): LucideIcon {
    if (type in EIGEN_DOC_ICONS) return EIGEN_DOC_ICONS[type as keyof typeof EIGEN_DOC_ICONS];
    if (isFolderType(type as never)) return Folder;
    return File;
}

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
    const scopeBlocks = scope === 'mail' || scope === 'actions' || scope === 'contacts';

    const { data, isFetching } = useSearch({
        ownerId: ctx.ownerId,
        q: parsed.q,
        sources: ['file'],
        limit: 6,
        enabled: !scopeBlocks && parsed.q.length > 0,
    });

    const results = useMemo<PaletteResult[]>(() => {
        if (!data) return [];
        return data.file.map((path, i) => ({
            kind: 'file' as const,
            id: `file.${path.id}`,
            title: stripEigenExtension(path.name),
            icon: iconForPath(path.type),
            group: 'file',
            rank: -i,
            payload: path,
            run: (rctx) => {
                const url = getDriveItemUrl(path);
                if (url) rctx.navigate(url);
                else rctx.openPreview(path);
            },
        }));
    }, [data]);

    const willSearch = !scopeBlocks && parsed.q.length > 0;
    const isDebouncing = !scopeBlocks && input.trim().length > 0 && input !== debouncedInput;
    return { results, isPending: (willSearch && isFetching) || isDebouncing };
}
