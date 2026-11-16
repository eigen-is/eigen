// The command palette's results for what is typed: it asks every source, such as commands, files, mail and help,
// and hands their rows to buildSections. The dialog runs it while closed too, so the recent files, which show
// before anything is typed, are read only while the palette is open.

import type { CommandContext, PaletteResult, PaletteScope, Sections } from '@workspace/lib/types/command-palette';
import { useMemo, useRef } from 'react';
import { SUGGESTED_COMMAND_IDS } from '../commands';
import { buildSections } from '../engine';
import { parseQuery } from '../parse-query';
import { useActionResults } from '../providers/actions';
import { useContactResults } from '../providers/contacts';
import { useDocCommentSearchResults } from '../providers/doc-comment-search';
import { useDocSearchResults } from '../providers/doc-search';
import { useFileSearchResults } from '../providers/file-search';
import { useHelpSearchResults } from '../providers/help-search';
import { useMailSearchResults } from '../providers/mail-search';
import { useRecentFileResults } from '../providers/recent-files';
import { useSmartResults } from '../providers/smart';

export function useCommandResults(
    ctx: CommandContext,
    input: string,
    scope: PaletteScope | undefined,
    open: boolean,
): Sections {
    const parsed = parseQuery(input);
    // A typed prefix (mail:, file:, >, @, ?) is the strongest signal — if the user typed
    // one, honor it over the chip scope they set earlier via Tab.
    const effectiveScope = parsed.scope ?? scope;
    const action = useActionResults(ctx, parsed.q);
    const contact = useContactResults(ctx, parsed.q);
    const smart = useSmartResults(ctx, input); // smart sees raw input — parses for shape
    const doc = useDocSearchResults(ctx, input, effectiveScope);
    const docComment = useDocCommentSearchResults(ctx, input, effectiveScope);
    const mail = useMailSearchResults(ctx, input, effectiveScope);
    const file = useFileSearchResults(ctx, input, effectiveScope);
    const help = useHelpSearchResults(input, effectiveScope);
    const recent = useRecentFileResults(ctx, input, open);

    // docComment is async but doc (sync IN DOCUMENT) is not — smoothing only the comment section
    // keeps the sync section instant while IN COMMENTS never collapses mid-flight.
    const stableDocComment = useStableWhilePending(docComment.results, docComment.isPending);
    const stableMail = useStableWhilePending(mail.results, mail.isPending);
    const stableFile = useStableWhilePending(file.results, file.isPending);
    const stableHelp = useStableWhilePending(help.results, help.isPending);

    return useMemo(
        () =>
            buildSections({
                action,
                contact,
                smart,
                doc,
                docComment: stableDocComment,
                mail: stableMail,
                file: stableFile,
                help: stableHelp,
                recent,
                input,
                scope: effectiveScope,
                suggestedCommandIds: SUGGESTED_COMMAND_IDS,
            }),
        [
            action,
            contact,
            smart,
            doc,
            stableDocComment,
            stableMail,
            stableFile,
            stableHelp,
            recent,
            input,
            effectiveScope,
        ],
    );
}

// Holds an async source's last results while its own query is in flight, so its section never flickers and a slow
// source, such as Pagefind's first load, can't freeze the others (the React docs' ref-in-render caching pattern).
function useStableWhilePending(results: PaletteResult[], isPending: boolean): PaletteResult[] {
    const ref = useRef(results);
    if (!isPending) ref.current = results;
    return ref.current;
}
