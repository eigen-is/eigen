// The palette's recent files, from the same cached list as Drive's Recent page, read only while the palette is open.
// The empty box lists the newest few; typed text keeps the first ones whose title matches, ranked above every search
// hit, so a file opened lately is the Top hit before the search answers. The open document, as the selection, is left out.

import type { CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { useMemo } from 'react';
import { useRecentPaths } from '../../drive/hooks/use-recent-paths';
import { parseQuery } from '../parse-query';
import { structuralMatchQuality } from '../rank';
import { fileToResult } from './file-search';

const RECENT_LIMIT = 5;
// Leaves Files room for search hits, since a short query matches many recent titles.
const RECENT_MATCH_LIMIT = 3;

export function useRecentFileResults(ctx: CommandContext, input: string, open: boolean): PaletteResult[] {
    const { data } = useRecentPaths(open);
    const { q } = parseQuery(input);

    return useMemo(() => {
        if (!data) return [];
        const selected = new Set(ctx.selection?.items.map((item) => item.id));
        const paths = data.filter((path) => !selected.has(path.id));
        if (!q) return paths.slice(0, RECENT_LIMIT).map((path, i) => fileToResult(path, q, 'recent', -i));
        return paths
            .filter((path) => structuralMatchQuality(q, stripEigenExtension(path.name)))
            .slice(0, RECENT_MATCH_LIMIT)
            .map((path) => fileToResult(path, q, 'file', 1));
    }, [data, ctx.selection, q]);
}
