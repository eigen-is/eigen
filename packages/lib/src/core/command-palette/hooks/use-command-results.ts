import type { CommandContext, PaletteResult, PaletteScope, Sections } from '@workspace/lib/types/command-palette';
import { useMemo, useRef } from 'react';
import { SUGGESTED_COMMAND_IDS } from '../commands';
import { buildSections } from '../engine';
import { parseQuery } from '../parse-query';
import { useActionResults } from '../providers/actions';
import { useContactResults } from '../providers/contacts';
import { useFileSearchResults } from '../providers/file-search';
import { useHelpSearchResults } from '../providers/help-search';
import { useMailSearchResults } from '../providers/mail-search';
import { useSmartResults } from '../providers/smart';

// Hold an async source's last results while ITS OWN query is in flight. The synchronous
// sources (actions/contacts/smart) rebuild on every keystroke; each async source
// (mail/file/help) stays put until its own results land — so the live FE results stay
// responsive while the remote sections never collapse or flicker, and a slow source
// (e.g. Pagefind's first WASM load) can't freeze the others. Writing to a ref in render
// is the React docs' caching pattern ("You Might Not Need an Effect").
function useStableWhilePending(results: PaletteResult[], isPending: boolean): PaletteResult[] {
    const ref = useRef(results);
    if (!isPending) ref.current = results;
    return ref.current;
}

export function useCommandResults(ctx: CommandContext, input: string, scope?: PaletteScope): Sections {
    const parsed = parseQuery(input);
    // A typed prefix (mail:, file:, >, @, ?) is the strongest signal — if the user typed
    // one, honour it over the chip scope they set earlier via Tab.
    const effectiveScope = parsed.scope ?? scope;
    const action = useActionResults(ctx, parsed.q);
    const contact = useContactResults(ctx, parsed.q);
    const smart = useSmartResults(ctx, input); // smart sees raw input — parses for shape
    const mail = useMailSearchResults(ctx, input, effectiveScope);
    const file = useFileSearchResults(ctx, input, effectiveScope);
    const help = useHelpSearchResults(input, effectiveScope);

    const stableMail = useStableWhilePending(mail.results, mail.isPending);
    const stableFile = useStableWhilePending(file.results, file.isPending);
    const stableHelp = useStableWhilePending(help.results, help.isPending);

    return useMemo(
        () =>
            buildSections({
                action,
                contact,
                smart,
                mail: stableMail,
                file: stableFile,
                help: stableHelp,
                input,
                scope: effectiveScope,
                suggestedCommandIds: SUGGESTED_COMMAND_IDS,
            }),
        [action, contact, smart, stableMail, stableFile, stableHelp, input, effectiveScope],
    );
}
