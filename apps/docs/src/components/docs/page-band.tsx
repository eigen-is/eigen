import type { Editor } from '@tiptap/react';
import { EditorContent, useEditorState } from '@tiptap/react';
import type { BandEdge, BandRoot, PageSetup } from '@workspace/lib/docs/eigendoc';
import { BAND_DISTANCE_MM, bandEdge, bandHasContent, FIRST_PAGE_BAND } from '@workspace/lib/docs/eigendoc';
import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, FileSliders, Hash, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { keepEditorFocus } from './editor-toolbar';
import { PageNumberItems, type PageNumberPreset } from './page-numbers';
import { PageSetupDialog } from './page-setup-dialog';

const BAND_LABEL: Record<BandRoot, string> = {
    header: 'Header',
    footer: 'Footer',
    headerFirst: 'First page header',
    footerFirst: 'First page footer',
};

type PageBandsProps = {
    edge: BandEdge;
    editors: Record<BandRoot, Editor>;
    setup: PageSetup;
    editing: BandRoot | null;
    // A writer's on a desktop or a tablet; a viewer and a phone see the bands, with no way in. The band double-clicked,
    // or none for the margin around them.
    onEnter?: (root: BandRoot | undefined, at: { left: number; top: number }) => void;
    // What the edited band's rule holds beside its label.
    controls: ReactNode;
};

// One margin of the page and the bands in it, each drawn by its own live editor: the header above the first block, the
// footer after the last. The margin's negative margins pull it over the page's padding to the paper's edges, so a
// double-click anywhere in it reaches it, and its min-height gives the room back, so a band, with its bar while edited,
// taller than the room left by its 1.27 cm pushes the body, as in Word. Not edited, a margin shows the band the long page's end prints, with
// content: page 1's header, the other pages' footer. Edited, with Different first page, both stack, page 1's at the
// paper's edge and the other pages' next to the body.
export function PageBands({ edge, editors, setup, editing, onEnter, controls }: PageBandsProps) {
    const first = FIRST_PAGE_BAND[edge];
    const roots: BandRoot[] = edge === 'header' ? [first, edge] : [edge, first];
    const firstHasContent = useEditorState({
        editor: editors[first],
        selector: ({ editor: e }) => bandHasContent(e.state.doc),
    });
    const otherHasContent = useEditorState({
        editor: editors[edge],
        selector: ({ editor: e }) => bandHasContent(e.state.doc),
    });
    const edited = editing !== null && bandEdge(editing) === edge;
    const printed = edge === 'header' && setup.differentFirstPage ? first : edge;
    const shows = (root: BandRoot) =>
        edited
            ? root === edge || setup.differentFirstPage
            : root === printed && (root === edge ? otherHasContent : firstHasContent);
    const room = edge === 'header' ? setup.margin.top : setup.margin.bottom;
    // At a margin narrower than its distance a band sits on the margin's edge, as the PDF and the docx put it.
    const distance = Math.min(BAND_DISTANCE_MM, room);
    const { left, right } = setup.margin;
    return (
        <div
            data-page-margin={edge}
            className={cn(
                'group relative print:hidden',
                edge === 'header' ? 'row-start-1' : 'row-start-4 flex flex-col justify-end',
                onEnter && 'cursor-text touch-manipulation',
            )}
            style={{
                margin:
                    edge === 'header' ? `-${room}mm -${right}mm 0 -${left}mm` : `0 -${right}mm -${room}mm -${left}mm`,
                padding:
                    edge === 'header' ? `${distance}mm ${right}mm 0 ${left}mm` : `0 ${right}mm ${distance}mm ${left}mm`,
                minHeight: `${room}mm`,
            }}
            onDoubleClick={
                onEnter &&
                ((event) => {
                    const band = event.target instanceof Element ? event.target.closest('[data-page-band]') : null;
                    const root = roots.find((r) => r === band?.getAttribute('data-page-band'));
                    // In the band being edited a double-click selects a word, as anywhere in text.
                    if (root ? root === editing : edited) return;
                    onEnter(root, { left: event.clientX, top: event.clientY });
                })
            }
        >
            {roots.map((root) => {
                // Google's bar, across the paper between the band and the body. It takes its room in the margin, so the
                // body moves down only by what the margin can't hold, and nothing covers it.
                const rule = edited && shows(root) && (
                    <div
                        data-band-rule
                        className="flex h-9 cursor-default items-center gap-3 border-y border-dashed border-muted-foreground/50 bg-muted px-4 text-sm"
                        style={{ marginLeft: `-${left}mm`, marginRight: `-${right}mm` }}
                    >
                        <span data-band-label className="font-medium">
                            {BAND_LABEL[root]}
                        </span>
                        {root === editing && controls}
                    </div>
                );
                return (
                    <div key={root} data-page-band={root} hidden={!shows(root)}>
                        {edge === 'footer' && rule}
                        <EditorContent editor={editors[root]} />
                        {edge === 'header' && rule}
                    </div>
                );
            })}
            {/* On hover it can't take room as a band does, so it fills the margin, and the space before it, the band's
                distance, gives way where a line doesn't fit after it: it never covers the body. */}
            {onEnter && !roots.some(shows) && (
                <div
                    data-band-hint
                    className={cn(
                        'pointer-events-none absolute flex overflow-hidden text-xs text-muted-foreground invisible pointer-fine:group-hover:visible',
                        edge === 'header' ? 'flex-col' : 'flex-col-reverse',
                    )}
                    style={{
                        [edge === 'header' ? 'top' : 'bottom']: 0,
                        height: `${room}mm`,
                        left: `${left}mm`,
                        right: `${right}mm`,
                    }}
                >
                    <div style={{ flexBasis: `${distance}mm` }} />
                    <span>Double-click to add a {edge}</span>
                </div>
            )}
        </div>
    );
}

type BandControlsProps = {
    band: BandRoot;
    editor: Editor;
    setup: PageSetup;
    onSetupChange: (from: PageSetup, to: PageSetup) => void;
    onDifferentFirstPage: (differentFirstPage: boolean) => void;
    onPageNumbers: (preset: PageNumberPreset) => void;
    onRemove: () => void;
};

// The controls on Google's bar between a band and the body: Different first page and Options.
export function BandControls({
    band,
    editor,
    setup,
    onSetupChange,
    onDifferentFirstPage,
    onPageNumbers,
    onRemove,
}: BandControlsProps) {
    const [pageSetupOpen, setPageSetupOpen] = useState(false);
    const differentFirstPageId = useId();
    return (
        <div className="ml-auto flex items-center gap-4">
            <div className="flex items-center gap-2">
                <Checkbox
                    id={differentFirstPageId}
                    checked={setup.differentFirstPage}
                    onCheckedChange={(checked) => onDifferentFirstPage(checked === true)}
                />
                <Label htmlFor={differentFirstPageId} className="font-normal">
                    Different first page
                </Label>
            </div>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-link hover:text-link">
                        Options
                        <ChevronDown className="h-4 w-4" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onCloseAutoFocus={keepEditorFocus(editor)}>
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <Hash className="h-4 w-4" /> Page numbers
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                            <PageNumberItems editor={editor} onPreset={onPageNumbers} />
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuItem onClick={() => setPageSetupOpen(true)}>
                        <FileSliders className="h-4 w-4" /> Page setup…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={onRemove}>
                        <Trash2 className="h-4 w-4" /> Remove {bandEdge(band)}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <PageSetupDialog
                open={pageSetupOpen}
                onOpenChange={setPageSetupOpen}
                setup={setup}
                canWrite
                onSetupChange={onSetupChange}
            />
        </div>
    );
}
