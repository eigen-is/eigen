// The docs editor's toolbar: the menus on the left, the formatting icon row in the middle and the share cluster on the
// right. It acts on the editor the caret is in, the body's, a band's or the open story's, and owns the dialogs its
// menus open, such as Page setup and Word count. The editor hands it what it shares with the page, such as the panels'
// and the outline's toggles.

import { formatForDisplay, useHotkey } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import type { BandEdge, PageSetup } from '@workspace/lib/docs/eigendoc';
import { usePrintPdf } from '@workspace/lib/drive';
import { useIsMobile, useMediaQuery } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isImageMime } from '@workspace/lib/types/drive';
import type { DocsTextWidth } from '@workspace/lib/types/settings';
import { TEXT_ALIGNS } from '@workspace/lib/vector';
import {
    CenteredToolbar,
    DocumentShareCluster,
    EditMenu,
    FileMenu,
    ToolbarSeparator,
    TooltipButton,
} from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { DocumentImportPicker, DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { ExportProgressDialog, useDocumentExport } from '@workspace/ui/components/drive/use-document-export';
import {
    ChoiceMenuItems,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { ColorPickerButton, FontSizeStepper } from '@workspace/ui/components/media';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import { focusLeftToEditor, Menubar } from '@workspace/ui/components/menubar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { printDocument } from '@workspace/ui/lib/printElement';
import {
    Baseline,
    Bold,
    CheckSquare,
    ChevronDown,
    Copy,
    FileSliders,
    Highlighter,
    ImagePlus,
    Italic,
    Link,
    Link2Off,
    List,
    ListOrdered,
    Printer,
    RemoveFormatting,
    Scissors,
    TextSelect,
    Trash2,
    Underline,
} from 'lucide-react';
import { useState } from 'react';
import { runClipboardCommand } from './clipboard';
import { CustomSpacingDialog } from './custom-spacing-dialog';
import { ALIGNMENT_LOOK, FormatMenu } from './format-menu';
import { useToolbarState } from './hooks/use-toolbar-state';
import { IndentationOptionsDialog } from './indentation-options-dialog';
import { InsertMenu } from './insert-menu';
import type { PageNumberPreset } from './page-numbers';
import { PageSetupDialog } from './page-setup-dialog';
import { RestartNumberingDialog } from './restart-numbering-dialog';
import { StylePicker } from './style-picker';
import { ShowOutlineItem, ToolsMenu, WORD_COUNT_HOTKEY, WordCountItem } from './tools-menu';
import { WordCountDialog } from './word-count-dialog';

// A closing menu hands focus to the editor the caret is in, after a pick or Esc, rather than back to its trigger, which
// would swallow the next keystrokes; a pick's own command focuses it a frame later. Whatever took the focus as the menu
// closed keeps it: an input a press outside landed on, a dialog the pick opened or the next menu, which would close at
// once without it. A viewer's menu returns it to the trigger, as the editor can't take it. Radix hands focus back a
// tick after the menu unmounts, when Tiptap has destroyed the editors of a document that closed with it, which still
// read as editable.
export const keepEditorFocus = (editor: Editor) => (e: Event) => {
    if (editor.isDestroyed || !editor.isEditable) return;
    e.preventDefault();
    if (focusLeftToEditor()) editor.commands.focus(null, { scrollIntoView: false });
};

type EditorToolbarProps = {
    // The editor the caret is in: the body's, a band's while the band is edited, or the open story's.
    editor: Editor;
    // Word count counts the body, from a band too.
    body: Editor;
    canWrite: boolean;
    offline: boolean;
    // The server's PDF may miss these edits, so Print falls back to browser print.
    unsyncedEdits: boolean;
    storageUnavailable: boolean;
    canUndo: boolean;
    canRedo: boolean;
    pageSetup: PageSetup;
    onPageSetupChange: (from: PageSetup, to: PageSetup) => void;
    // The reader's own column on a page-less doc, which Page setup shows beside the doc's format.
    textWidth: DocsTextWidth;
    onTextWidthChange: (width: DocsTextWidth) => void;
    // Update 'Normal text' to match, the body's only.
    onUpdateNormalStyle?: () => void;
    onAccessDialogOpen: () => void;
    path: DrivePath;
    onToggleCommentPanel?: () => void;
    commentPanelOpen?: boolean;
    onToggleActivityPanel?: () => void;
    activityPanelOpen?: boolean;
    assignedCommentCount?: number;
    onImageUpload?: (file: File) => void;
    onImagePickFromDrive?: (paths: DrivePath[]) => void;
    onReplaceImage: () => void;
    // Threaded only when the doc can hold comments (chatFolderId present); gates the Insert-menu item.
    onAddComment?: () => void;
    onInsertEquation?: () => void;
    // Inserts a footnote and opens its note; a writer's on a desktop or a tablet only.
    onInsertFootnote?: () => void;
    onInsertTextBox?: () => void;
    // The caret is in the open story, a note or a text box, which holds paragraphs only.
    inStory: boolean;
    // Puts the caret in a band, and writes a page-number preset there; a writer's on a desktop or a tablet only.
    onEnterBand?: (edge: BandEdge) => void;
    onPageNumbers?: (preset: PageNumberPreset) => void;
    outlineShown: boolean;
    onToggleOutline: () => void;
};

export const EditorToolbar = ({
    editor,
    body,
    path,
    canWrite,
    offline,
    unsyncedEdits,
    storageUnavailable,
    canUndo,
    canRedo,
    pageSetup,
    onPageSetupChange,
    textWidth,
    onTextWidthChange,
    onUpdateNormalStyle,
    onAccessDialogOpen,
    onToggleCommentPanel,
    commentPanelOpen,
    onToggleActivityPanel,
    activityPanelOpen,
    assignedCommentCount,
    onImageUpload,
    onImagePickFromDrive,
    onReplaceImage,
    onAddComment,
    onInsertEquation,
    onInsertFootnote,
    onInsertTextBox,
    inStory,
    onEnterBand,
    onPageNumbers,
    outlineShown,
    onToggleOutline,
}: EditorToolbarProps) => {
    const [linkUrl, setLinkUrl] = useState('');
    const [linkDialogOpen, setLinkDialogOpen] = useState(false);
    const [pageSetupOpen, setPageSetupOpen] = useState(false);
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const [importPickerOpen, setImportPickerOpen] = useState(false);
    const [wordCountOpen, setWordCountOpen] = useState(false);
    const [restartNumberingOpen, setRestartNumberingOpen] = useState(false);
    const [customSpacingOpen, setCustomSpacingOpen] = useState(false);
    const [indentationOpen, setIndentationOpen] = useState(false);
    const active = useToolbarState(editor);
    // A range of mixed alignments checks no Align item, and its trigger draws Left's icon.
    const AlignmentIcon = ALIGNMENT_LOOK[active.alignment ?? 'left'].icon;
    const { exportPath, isExporting } = useDocumentExport();
    // The icon row folds from its right end, as Google's does, so its order is its priority order. All it folds
    // stays in Format and Insert. Each breakpoint is where a part of the row fits beside the menus at its widest,
    // with a link in a JetBrains Mono "Normal text". The row stays centered in the bar.
    const showsRow = useMediaQuery('(min-width: 1090px)');
    const showsMiddle = useMediaQuery('(min-width: 1270px)');
    const showsAll = useMediaQuery('(min-width: 1490px)');
    // A phone has no room for more than four menus beside the offline badge, so Tools folds into the kebab.
    const isMobile = useIsMobile();

    // Document-level: a viewer's editor is not editable, so an editor keymap would never see the key.
    useHotkey(WORD_COUNT_HOTKEY, (e) => {
        e.preventDefault();
        setWordCountOpen(true);
    });

    const openWordCount = () => setWordCountOpen(true);

    const { printPdf } = usePrintPdf(printDocument);
    const print = () => printPdf(path.ownerId, path.mountId, path.id, !offline && !unsyncedEdits);

    // On <html>, which the key reaches before the document: this handler stops it there, so EigenApp's ⌘P, browser
    // print for every other app, never sees it.
    useHotkey(
        'Mod+P',
        (e) => {
            e.preventDefault();
            print();
        },
        { target: document.documentElement },
    );

    const handleLinkOperation = () => {
        if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
        } else {
            setLinkDialogOpen(true);
        }
    };

    const applyLink = () => {
        if (!linkUrl) return;
        const { from, to } = editor.state.selection;
        if (from === to) {
            editor
                .chain()
                .focus()
                .insertContent({ type: 'text', text: linkUrl, marks: [{ type: 'link', attrs: { href: linkUrl } }] })
                .run();
        } else {
            editor.chain().focus().setLink({ href: linkUrl }).run();
        }
        setLinkUrl('');
        setLinkDialogOpen(false);
    };

    const keepActiveEditorFocus = keepEditorFocus(editor);

    const setTextColor = (color: string) => {
        if (color) {
            editor.chain().focus().setColor(color).run();
        } else {
            editor.chain().focus().unsetColor().run();
        }
    };

    const setHighlightColor = (color: string) => {
        if (color) {
            editor.chain().focus().toggleHighlight({ color }).run();
        } else {
            editor.chain().focus().unsetHighlight().run();
        }
    };

    const clearFormatting = () => {
        editor.chain().focus().clearFormatting().run();
    };

    const handleImageFromDevice = (files: File[]) => {
        const file = files[0];
        if (file && onImageUpload) onImageUpload(file);
    };

    return (
        <>
            <CenteredToolbar
                left={
                    <Menubar>
                        <FileMenu
                            path={path}
                            canWrite={canWrite}
                            onAccessDialogOpen={onAccessDialogOpen}
                            onExport={(format) => exportPath(path, format)}
                            onImport={() => setImportPickerOpen(true)}
                            createLabel="New doc"
                            createType="doc"
                            onCloseAutoFocus={keepActiveEditorFocus}
                        >
                            <DropdownMenuItem onClick={() => setPageSetupOpen(true)}>
                                <FileSliders className="h-4 w-4" /> Page setup…
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={print}>
                                <Printer className="h-4 w-4" /> Print
                            </DropdownMenuItem>
                        </FileMenu>

                        <EditMenu
                            canEdit={canWrite}
                            canUndo={canUndo}
                            canRedo={canRedo}
                            onUndo={() => editor.chain().focus().undo().run()}
                            onRedo={() => editor.chain().focus().redo().run()}
                            onCloseAutoFocus={keepActiveEditorFocus}
                            selectionItems={
                                <>
                                    <DropdownMenuItem
                                        disabled={!canWrite || active.selectionEmpty}
                                        onClick={() => runClipboardCommand(editor, 'cut')}
                                    >
                                        <Scissors className="h-4 w-4" /> Cut
                                        <DropdownMenuShortcut>{formatForDisplay('Mod+X')}</DropdownMenuShortcut>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        disabled={active.selectionEmpty}
                                        onClick={() => runClipboardCommand(editor, 'copy')}
                                    >
                                        <Copy className="h-4 w-4" /> Copy
                                        <DropdownMenuShortcut>{formatForDisplay('Mod+C')}</DropdownMenuShortcut>
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => editor.chain().focus().selectAll().run()}>
                                        <TextSelect className="h-4 w-4" /> Select all
                                        <DropdownMenuShortcut>{formatForDisplay('Mod+A')}</DropdownMenuShortcut>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        variant="destructive"
                                        disabled={!canWrite || active.selectionEmpty}
                                        onClick={() => editor.chain().focus().deleteSelection().run()}
                                    >
                                        <Trash2 className="h-4 w-4" /> Delete
                                    </DropdownMenuItem>
                                </>
                            }
                        />

                        {canWrite && (
                            <>
                                <FormatMenu
                                    editor={editor}
                                    active={active}
                                    keepEditorFocus={keepActiveEditorFocus}
                                    setTextColor={setTextColor}
                                    setHighlightColor={setHighlightColor}
                                    clearFormatting={clearFormatting}
                                    onRestartNumbering={() => setRestartNumberingOpen(true)}
                                    onCustomSpacing={() => setCustomSpacingOpen(true)}
                                    onUpdateNormalStyle={onUpdateNormalStyle}
                                    onIndentationOptions={() => setIndentationOpen(true)}
                                    onPageSetup={() => setPageSetupOpen(true)}
                                    onReplaceImage={onReplaceImage}
                                    onEnterBand={onEnterBand}
                                    onPageNumbers={onPageNumbers}
                                    pageless={pageSetup.pageless}
                                    onSwitchFormat={() =>
                                        onPageSetupChange(pageSetup, { ...pageSetup, pageless: !pageSetup.pageless })
                                    }
                                />

                                <InsertMenu
                                    editor={editor}
                                    active={active}
                                    keepEditorFocus={keepActiveEditorFocus}
                                    onLink={handleLinkOperation}
                                    onInsertImage={onImageUpload ? () => setImagePickerOpen(true) : undefined}
                                    onAddComment={onAddComment}
                                    onInsertEquation={onInsertEquation}
                                    onInsertFootnote={onInsertFootnote}
                                    onInsertTextBox={onInsertTextBox}
                                    inStory={inStory}
                                    held={editor !== body}
                                    pageless={pageSetup.pageless}
                                    onEnterBand={onEnterBand}
                                    onPageNumbers={onPageNumbers}
                                />
                            </>
                        )}

                        {!isMobile && (
                            <ToolsMenu
                                keepEditorFocus={keepActiveEditorFocus}
                                onWordCount={openWordCount}
                                outlineShown={outlineShown}
                                onToggleOutline={onToggleOutline}
                            />
                        )}
                    </Menubar>
                }
                center={
                    canWrite &&
                    showsRow && (
                        <div className="flex" role="toolbar" aria-label="Formatting">
                            <ToolbarSeparator />

                            {/* Heading / paragraph selector */}
                            <StylePicker editor={editor} active={active} keepEditorFocus={keepActiveEditorFocus} />

                            <ToolbarSeparator />

                            {/* Font family selector */}
                            <FontPicker
                                value={active.fontName}
                                onChange={(f) => editor.chain().focus().setFontFamily(f).run()}
                                onCloseAutoFocus={keepActiveEditorFocus}
                            />

                            <ToolbarSeparator />

                            <FontSizeStepper
                                value={active.fontSize}
                                onChange={(size) => editor.chain().focus().applyFontSize(size).run()}
                                onStep={(by) => editor.chain().focus().stepFontSize(by).run()}
                            />

                            <ToolbarSeparator />

                            {/* Text formatting toggle group */}
                            <div className="flex items-center gap-0.5">
                                <TooltipButton
                                    icon={Bold}
                                    tooltipText={`Bold (${formatForDisplay('Mod+B')})`}
                                    active={active.bold}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleBold().run()}
                                />
                                <TooltipButton
                                    icon={Italic}
                                    tooltipText={`Italic (${formatForDisplay('Mod+I')})`}
                                    active={active.italic}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleItalic().run()}
                                />
                                <TooltipButton
                                    icon={Underline}
                                    tooltipText={`Underline (${formatForDisplay('Mod+U')})`}
                                    active={active.underline}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleUnderline().run()}
                                />
                            </div>

                            {showsMiddle && (
                                <>
                                    <ToolbarSeparator />

                                    <ColorPickerButton
                                        icon={Baseline}
                                        tooltipText="Text color"
                                        value={active.color}
                                        resetLabel="Default"
                                        showSwatch
                                        onChange={setTextColor}
                                    />
                                    <ColorPickerButton
                                        icon={Highlighter}
                                        tooltipText="Highlight color"
                                        active={active.highlight}
                                        value={active.highlightColor}
                                        resetLabel="None"
                                        onChange={setHighlightColor}
                                    />

                                    <ToolbarSeparator />

                                    {/* Insert actions */}
                                    <div className="flex items-center gap-0.5">
                                        <TooltipButton
                                            icon={Link}
                                            tooltipText="Add link"
                                            active={active.link}
                                            preventFocusLoss
                                            onClick={handleLinkOperation}
                                        />
                                        {active.link && (
                                            <TooltipButton
                                                icon={Link2Off}
                                                tooltipText="Remove link"
                                                preventFocusLoss
                                                onClick={() => editor.chain().focus().unsetLink().run()}
                                            />
                                        )}
                                        {onImageUpload && (
                                            <TooltipButton
                                                icon={ImagePlus}
                                                tooltipText="Insert image"
                                                onClick={() => setImagePickerOpen(true)}
                                            />
                                        )}
                                    </div>
                                </>
                            )}

                            {showsAll && (
                                <>
                                    <ToolbarSeparator />

                                    {/* Alignment, one dropdown as Google's */}
                                    <DropdownMenu modal={false}>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <DropdownMenuTrigger asChild>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-8 px-2 gap-1"
                                                        aria-label="Align"
                                                        onMouseDown={(e) => e.preventDefault()}
                                                    >
                                                        <AlignmentIcon className="h-4 w-4" />
                                                        <ChevronDown className="h-3 w-3" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                            </TooltipTrigger>
                                            <TooltipContent>Align</TooltipContent>
                                        </Tooltip>
                                        <DropdownMenuContent onCloseAutoFocus={keepActiveEditorFocus}>
                                            <ChoiceMenuItems
                                                value={active.alignment}
                                                options={TEXT_ALIGNS.map((alignment) => {
                                                    const { label, icon: Icon } = ALIGNMENT_LOOK[alignment];
                                                    return {
                                                        value: alignment,
                                                        label: (
                                                            <>
                                                                <Icon className="h-4 w-4" /> {label}
                                                            </>
                                                        ),
                                                    };
                                                })}
                                                onChange={(alignment) =>
                                                    editor.chain().focus().setTextAlign(alignment).run()
                                                }
                                            />
                                        </DropdownMenuContent>
                                    </DropdownMenu>

                                    <ToolbarSeparator />

                                    {/* Lists toggle group */}
                                    <div className="flex items-center gap-0.5">
                                        <TooltipButton
                                            icon={List}
                                            tooltipText="Bulleted list"
                                            active={active.bulletList}
                                            preventFocusLoss
                                            onClick={() => editor.chain().focus().toggleBulletList().run()}
                                        />
                                        <TooltipButton
                                            icon={ListOrdered}
                                            tooltipText="Numbered list"
                                            active={active.orderedList}
                                            preventFocusLoss
                                            onClick={() => editor.chain().focus().toggleOrderedList().run()}
                                        />
                                        <TooltipButton
                                            icon={CheckSquare}
                                            tooltipText="Checklist"
                                            active={active.taskList}
                                            preventFocusLoss
                                            onClick={() => editor.chain().focus().toggleTaskList().run()}
                                        />
                                    </div>

                                    <ToolbarSeparator />

                                    <TooltipButton
                                        icon={RemoveFormatting}
                                        tooltipText={`Clear formatting (${formatForDisplay('Mod+\\')})`}
                                        onClick={clearFormatting}
                                    />
                                </>
                            )}
                        </div>
                    )
                }
                right={
                    <DocumentShareCluster
                        canWrite={canWrite}
                        offline={offline}
                        storageUnavailable={storageUnavailable}
                        onAccessDialogOpen={onAccessDialogOpen}
                        onToggleCommentPanel={onToggleCommentPanel}
                        commentPanelOpen={commentPanelOpen}
                        onToggleActivityPanel={onToggleActivityPanel}
                        activityPanelOpen={activityPanelOpen}
                        assignedCommentCount={assignedCommentCount}
                        watchTarget={{ ownerId: path.ownerId, mountId: path.mountId, pathId: path.id }}
                        mobileMenuItems={
                            <>
                                <WordCountItem onClick={openWordCount} />
                                <ShowOutlineItem onClick={onToggleOutline} />
                            </>
                        }
                    />
                }
            />
            {onImageUpload && (
                <DrivePickerWithUpload
                    open={imagePickerOpen}
                    onOpenChange={setImagePickerOpen}
                    title="Insert image"
                    canPick={(item) => isImageMime(item.mimeType)}
                    onPickFromDrive={(paths) => onImagePickFromDrive?.(paths)}
                    onPickFromDevice={handleImageFromDevice}
                    accept="image/*"
                />
            )}

            <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
                <DialogContent size="sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle>Add link</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label htmlFor="link">URL</Label>
                            <Input
                                id="link"
                                autoFocus
                                placeholder="https://example.com"
                                value={linkUrl}
                                onChange={(e) => setLinkUrl(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        applyLink();
                                    }
                                }}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setLinkDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="button" onClick={applyLink}>
                            Add link
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <PageSetupDialog
                open={pageSetupOpen}
                onOpenChange={setPageSetupOpen}
                onCloseAutoFocus={keepActiveEditorFocus}
                setup={pageSetup}
                canWrite={canWrite}
                onSetupChange={onPageSetupChange}
                // A phone's column is its screen.
                textWidth={isMobile ? undefined : textWidth}
                onTextWidthChange={isMobile ? undefined : onTextWidthChange}
            />

            <WordCountDialog
                editor={body}
                open={wordCountOpen}
                onOpenChange={setWordCountOpen}
                onCloseAutoFocus={keepActiveEditorFocus}
            />

            <RestartNumberingDialog
                editor={editor}
                open={restartNumberingOpen}
                onOpenChange={setRestartNumberingOpen}
            />

            <CustomSpacingDialog
                editor={editor}
                normal={editor.storage.eigenFontSize.normalStyle()}
                open={customSpacingOpen}
                onOpenChange={setCustomSpacingOpen}
            />

            <IndentationOptionsDialog
                editor={editor}
                normal={editor.storage.eigenFontSize.normalStyle()}
                open={indentationOpen}
                onOpenChange={setIndentationOpen}
            />

            <ExportProgressDialog open={isExporting} />

            <DocumentImportPicker
                path={path}
                open={importPickerOpen}
                onOpenChange={setImportPickerOpen}
                target="eigendoc"
            />
        </>
    );
};
