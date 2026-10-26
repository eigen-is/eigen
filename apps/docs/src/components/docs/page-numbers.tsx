import type { Editor } from '@tiptap/react';
import type { BandRoot, PageNumberKind, PageSetup } from '@workspace/lib/docs/eigendoc';
import { bandHasContent, FIRST_PAGE_BAND, PAGE_NUMBER_KINDS } from '@workspace/lib/docs/eigendoc';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { PAGE_NUMBER_FIELD_NAMES } from './extensions/page-number';

// Google's Insert › Page numbers pictures: a number on the right of the header or the footer, on every page or from
// page 2.
export const PAGE_NUMBER_PRESETS = [
    { label: 'In the header', band: 'header', onFirstPage: true },
    { label: 'In the header, not on the first page', band: 'header', onFirstPage: false },
    { label: 'In the footer', band: 'footer', onFirstPage: true },
    { label: 'In the footer, not on the first page', band: 'footer', onFirstPage: false },
] as const;

export type PageNumberPreset = (typeof PAGE_NUMBER_PRESETS)[number];

const RIGHT_ALIGNED_NUMBER = {
    type: 'paragraph',
    attrs: { textAlign: 'right' },
    content: [{ type: 'pageNumber', attrs: { kind: 'page' } }],
};

// Where a band's page numbers sit, last first, so deleting one leaves the others' positions as they were.
function pageNumberPositions(editor: Editor): number[] {
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'pageNumber' && node.attrs.kind === 'page') positions.unshift(pos);
    });
    return positions;
}

// Below what the band holds, or in place of the empty paragraph a band starts with; a band numbered already keeps
// its number, so a preset picked twice places one.
function addPageNumber(editor: Editor) {
    if (pageNumberPositions(editor).length > 0) return;
    const end = editor.state.doc.content.size;
    editor
        .chain()
        .insertContentAt(bandHasContent(editor.state.doc) ? end : { from: 0, to: end }, RIGHT_ALIGNED_NUMBER)
        .run();
}

function removePageNumbers(editor: Editor) {
    const positions = pageNumberPositions(editor);
    if (positions.length === 0) return;
    editor.commands.command(({ tr }) => {
        for (const pos of positions) tr.delete(pos, pos + 1);
        return true;
    });
}

// Not on the first page is Google's Show on first page off: the first page's bands lose their numbers. Every band's
// editor is on the page, hidden or not, so each writes its root.
export function applyPageNumberPreset(
    editors: Record<BandRoot, Editor>,
    { band, onFirstPage }: PageNumberPreset,
    setup: PageSetup,
    onSetupChange: (from: PageSetup, to: PageSetup) => void,
) {
    if (!onFirstPage && !setup.differentFirstPage) onSetupChange(setup, { ...setup, differentFirstPage: true });
    addPageNumber(editors[band]);
    if (onFirstPage && setup.differentFirstPage) addPageNumber(editors[FIRST_PAGE_BAND[band]]);
    if (!onFirstPage) {
        removePageNumbers(editors.headerFirst);
        removePageNumbers(editors.footerFirst);
    }
}

type PageNumberItemsProps = {
    // The editor Page number and Page count go into, at its caret.
    editor: Editor;
    onPreset: (preset: PageNumberPreset) => void;
};

const insertField = (editor: Editor, kind: PageNumberKind) =>
    editor.chain().focus().insertContent({ type: 'pageNumber', attrs: { kind } }).run();

// The Page numbers submenu of Insert › Page elements, Format and a band's Options. Text-only, so every label lines up.
export const PageNumberItems = ({ editor, onPreset }: PageNumberItemsProps) => (
    <>
        {PAGE_NUMBER_PRESETS.map((preset) => (
            <DropdownMenuItem key={preset.label} onClick={() => onPreset(preset)}>
                {preset.label}
            </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* Google's Page number and Page count go in at the caret, wherever it is. */}
        {PAGE_NUMBER_KINDS.map((kind) => (
            <DropdownMenuItem key={kind} onClick={() => insertField(editor, kind)}>
                {PAGE_NUMBER_FIELD_NAMES[kind]}
            </DropdownMenuItem>
        ))}
    </>
);
