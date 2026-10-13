import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { EditorContent, useEditorState } from '@tiptap/react';
import type { BandRoot, PageNumberKind, PageSetup } from '@workspace/lib/docs/eigendoc';
import { bandHasContent } from '@workspace/lib/docs/eigendoc';
import { isImageMime } from '@workspace/lib/types/drive';
import { TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { Label } from '@workspace/ui/components/label';
import { AlignmentPicker, PropertiesPanel, PropertySection } from '@workspace/ui/components/properties-panel';
import { cn } from '@workspace/ui/lib/utils';
import { Bold, Files, Hash, ImagePlus, Italic, Underline, X } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import type { DocMedia } from './doc-editor';

// Google's Insert › Page numbers pictures: a number on the right of the header or the footer, on every page or from
// page 2.
export const PAGE_NUMBER_PRESETS = [
    { label: 'In the header', band: 'header', onFirstPage: true },
    { label: 'In the header, not on the first page', band: 'header', onFirstPage: false },
    { label: 'In the footer', band: 'footer', onFirstPage: true },
    { label: 'In the footer, not on the first page', band: 'footer', onFirstPage: false },
] as const;

type PageNumberPreset = (typeof PAGE_NUMBER_PRESETS)[number];

// What the panel opens on: a band to put the caret in, with a preset the menu picked to place first, or the
// page-number presets.
export type BandRequest = { band: BandRoot; preset?: PageNumberPreset } | { section: 'pageNumbers' };

const FIRST_PAGE_BAND = { header: 'headerFirst', footer: 'footerFirst' } as const;

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

type HeadersFootersPanelProps = {
    // All four, so a preset reaches a first-page band the panel doesn't show.
    editors: Record<BandRoot, Editor>;
    media: DocMedia;
    setup: PageSetup;
    onSetupChange: (from: PageSetup, to: PageSetup) => void;
    request: BandRequest;
    onClose: () => void;
};

export function HeadersFootersPanel({
    editors,
    media,
    setup,
    onSetupChange,
    request,
    onClose,
}: HeadersFootersPanelProps) {
    const [focused, setFocused] = useState<BandRoot>('band' in request ? request.band : 'header');
    const firstPresetRef = useRef<HTMLButtonElement>(null);
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const differentFirstPageId = useId();
    // A first page's band the panel no longer shows, as Different first page went off, hands over to the other pages'.
    const active =
        setup.differentFirstPage || (focused !== 'headerFirst' && focused !== 'footerFirst')
            ? focused
            : focused === 'headerFirst'
              ? 'header'
              : 'footer';
    const editor = editors[active];

    const look = useEditorState({
        editor,
        selector: ({ editor: e }) => ({
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            underline: e.isActive('underline'),
            alignment: e.isActive({ textAlign: 'center' })
                ? ('center' as const)
                : e.isActive({ textAlign: 'right' })
                  ? ('right' as const)
                  : ('left' as const),
        }),
    });

    const setDifferentFirstPage = (differentFirstPage: boolean) =>
        onSetupChange(setup, { ...setup, differentFirstPage });

    // Not on the first page is Google's Show on first page off: the first page's bands lose their numbers.
    const applyPreset = ({ band, onFirstPage }: PageNumberPreset) => {
        if (!onFirstPage && !setup.differentFirstPage) setDifferentFirstPage(true);
        addPageNumber(editors[band]);
        if (onFirstPage && setup.differentFirstPage) addPageNumber(editors[FIRST_PAGE_BAND[band]]);
        if (!onFirstPage) {
            removePageNumbers(editors.headerFirst);
            removePageNumbers(editors.footerFirst);
        }
    };

    const insertField = (kind: PageNumberKind) =>
        editor.chain().focus().insertContent({ type: 'pageNumber', attrs: { kind } }).run();

    // A menu or a click on the page asks for a band: the panel places the menu's preset and puts the caret there.
    // Format › Page numbers asks for the presets, focused a frame later as Tiptap focuses a band.
    const open = useEffectEvent((request: BandRequest) => {
        if (!('band' in request)) {
            requestAnimationFrame(() => firstPresetRef.current?.focus());
            return;
        }
        if (request.preset) applyPreset(request.preset);
        setFocused(request.band);
        editors[request.band].commands.focus('end');
    });
    useEffect(() => open(request), [request]);

    const bandField = (field: BandRoot, label: string) => (
        <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div
                role="group"
                data-band={field}
                aria-label={label}
                // The page's light look, so a band's colors read as they print.
                className={cn(
                    'eigen-paper rounded-md border bg-background px-2 py-1 text-foreground',
                    field === active && 'border-ring',
                )}
                onFocus={() => setFocused(field)}
            >
                <EditorContent editor={editors[field]} />
            </div>
        </div>
    );

    return (
        <PropertiesPanel
            title="Headers and footers"
            actions={<TooltipButton icon={X} tooltipText="Close" onClick={onClose} />}
        >
            <div className="app-gutter flex flex-wrap items-center gap-1 border-b" role="toolbar" aria-label="Band">
                <TooltipButton
                    icon={Bold}
                    tooltipText={`Bold (${formatForDisplay('Mod+B')})`}
                    active={look.bold}
                    preventFocusLoss
                    onClick={() => editor.chain().focus().toggleBold().run()}
                />
                <TooltipButton
                    icon={Italic}
                    tooltipText={`Italic (${formatForDisplay('Mod+I')})`}
                    active={look.italic}
                    preventFocusLoss
                    onClick={() => editor.chain().focus().toggleItalic().run()}
                />
                <TooltipButton
                    icon={Underline}
                    tooltipText={`Underline (${formatForDisplay('Mod+U')})`}
                    active={look.underline}
                    preventFocusLoss
                    onClick={() => editor.chain().focus().toggleUnderline().run()}
                />
                <AlignmentPicker
                    value={look.alignment}
                    onChange={(alignment) => editor.chain().focus().setTextAlign(alignment).run()}
                />
                <TooltipButton
                    icon={Hash}
                    tooltipText="Page number"
                    preventFocusLoss
                    onClick={() => insertField('page')}
                />
                <TooltipButton
                    icon={Files}
                    tooltipText="Page count"
                    preventFocusLoss
                    onClick={() => insertField('pages')}
                />
                {media.mediaFolderId && (
                    <TooltipButton
                        icon={ImagePlus}
                        tooltipText="Insert image"
                        onClick={() => setImagePickerOpen(true)}
                    />
                )}
            </div>

            <PropertySection title="Pages">
                <div className="flex items-center gap-2">
                    <Checkbox
                        id={differentFirstPageId}
                        checked={setup.differentFirstPage}
                        onCheckedChange={(checked) => setDifferentFirstPage(checked === true)}
                    />
                    <Label htmlFor={differentFirstPageId} className="text-xs font-normal">
                        Different first page
                    </Label>
                </div>
            </PropertySection>

            {setup.differentFirstPage && (
                <PropertySection title="First page">
                    {bandField('headerFirst', 'First page header')}
                    {bandField('footerFirst', 'First page footer')}
                </PropertySection>
            )}

            <PropertySection title={setup.differentFirstPage ? 'From page 2' : 'Every page'}>
                {bandField('header', 'Header')}
                {bandField('footer', 'Footer')}
            </PropertySection>

            <PropertySection title="Page numbers">
                {(
                    [
                        ['header', 'Header'],
                        ['footer', 'Footer'],
                    ] as const
                ).map(([band, label]) => (
                    <div key={band} role="group" aria-label={`${label} page numbers`} className="space-y-1">
                        <span className="text-xs text-muted-foreground">{label}</span>
                        <div data-page-numbers className="grid grid-cols-2 gap-1.5">
                            {PAGE_NUMBER_PRESETS.filter((preset) => preset.band === band).map((preset) => (
                                <Button
                                    key={preset.label}
                                    ref={preset === PAGE_NUMBER_PRESETS[0] ? firstPresetRef : undefined}
                                    variant="outline"
                                    size="sm"
                                    className="text-xs"
                                    onClick={() => applyPreset(preset)}
                                >
                                    {preset.onFirstPage ? 'Every page' : 'From page 2'}
                                </Button>
                            ))}
                        </div>
                    </div>
                ))}
            </PropertySection>

            {media.mediaFolderId && (
                <DrivePickerWithUpload
                    open={imagePickerOpen}
                    onOpenChange={setImagePickerOpen}
                    title="Insert image"
                    canPick={(item) => isImageMime(item.mimeType)}
                    onPickFromDrive={(paths) => media.insertFromDrive(() => editor, paths)}
                    onPickFromDevice={(files) => files[0] && media.uploadImage(() => editor, files[0])}
                    accept="image/*"
                />
            )}
        </PropertiesPanel>
    );
}
