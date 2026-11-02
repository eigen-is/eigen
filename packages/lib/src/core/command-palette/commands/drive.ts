// The palette's Selection commands: one per row a page published for the Drive items it has selected,
// such as a Drive listing's item menu or an open document's File menu. A row is the menu's own row
// bound to the selection, so the palette offers what the menu offers, under the menu's label, with the
// item's name beside it. The action provider adds these to the static catalog.

import type { Command, CommandContext } from '@workspace/lib/types/command-palette';
import { EXPORT_FORMAT_LABELS, exportFormatsFor, stripEigenExtension } from '@workspace/lib/types/drive';

// The words a row is found by besides its label, such as "delete" for Move to trash.
const KEYWORDS: Partial<Record<string, string[]>> = {
    'open-new-tab': ['tab'],
    'quick-look': ['preview', 'look'],
    rename: ['name'],
    download: ['save'],
    'download-as': ['export'],
    share: ['access', 'permissions'],
    'email-collaborators': ['notify'],
    'copy-link': ['url', 'share'],
    'mail-to': ['send', 'attach', 'compose'],
    trash: ['delete', 'remove'],
    'remove-shared': ['delete', 'leave'],
};

export function selectionCommands(ctx: CommandContext): Command[] {
    const items = ctx.selection?.items ?? [];
    if (items.length === 0 || !ctx.selectionActions) return [];
    const [first] = items;
    const name = items.length === 1 ? stripEigenExtension(first.name) : undefined;
    const keywordsFor = (id: string) => [...(KEYWORDS[id] ?? []), ...(name ? [first.name] : [])];

    const commands = ctx.selectionActions.flatMap(({ action, run }) =>
        action.id === 'download-as'
            ? []
            : [
                  {
                      id: `selection.${action.id}`,
                      title:
                          items.length > 1 && action.pluralLabel
                              ? action.pluralLabel.replace('{n}', String(items.length))
                              : action.label,
                      keywords: keywordsFor(action.id),
                      icon: action.icon,
                      run: () => run(),
                  },
              ],
    );
    // One row per format, after every other row, so with an empty query the formats never push the
    // rest out of the section; typing "download" lists them.
    const downloadAs = ctx.selectionActions.find(({ action }) => action.id === 'download-as');
    const formats = downloadAs
        ? exportFormatsFor(first.type).map((format) => ({
              id: `selection.download-as.${format}`,
              title: `Download as ${EXPORT_FORMAT_LABELS[format]}`,
              keywords: [...keywordsFor('download-as'), format],
              icon: downloadAs.action.icon,
              run: () => downloadAs.run(format),
          }))
        : [];

    // The page publishes its rows in its menu's order, and the section keeps it.
    return [...commands, ...formats].map<Command>((command, index, all) => ({
        ...command,
        subtitle: name,
        baseRank: all.length - index,
        group: 'selection',
    }));
}
