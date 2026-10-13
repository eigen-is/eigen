import { formatForDisplay, useHotkey } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { DOCX_MIME } from '@workspace/lib/constants/mime';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { useIsMobile, useMediaQuery } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isImageMime } from '@workspace/lib/types/drive';
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
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { DocumentImportPicker } from '@workspace/ui/components/drive/document-import-picker';
import { ExportProgressDialog, useDocumentExport } from '@workspace/ui/components/drive/use-document-export';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { ColorPickerButton } from '@workspace/ui/components/media';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
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
import { ALIGNMENT_LOOK, FormatMenu } from './format-menu';
import { useToolbarState } from './hooks/use-toolbar-state';
import { InsertMenu } from './insert-menu';
import { PageSetupDialog } from './page-setup-dialog';
import { RestartNumberingDialog } from './restart-numbering-dialog';
import { StylePicker } from './style-picker';
import { ToolsMenu, WORD_COUNT_HOTKEY, WordCountItem } from './tools-menu';
import { WordCountDialog } from './word-count-dialog';

type EditorToolbarProps = {
    editor: Editor;
    canWrite: boolean;
    offline: boolean;
    storageUnavailable: boolean;
    canUndo: boolean;
    canRedo: boolean;
    pageSetup: PageSetup;
    onPageSetupChange: (setup: PageSetup) => void;
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
};

export const EditorToolbar = ({
    editor,
    path,
    canWrite,
    offline,
    storageUnavailable,
    canUndo,
    canRedo,
    pageSetup,
    onPageSetupChange,
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
}: EditorToolbarProps) => {
    const [linkUrl, setLinkUrl] = useState('');
    const [linkDialogOpen, setLinkDialogOpen] = useState(false);
    const [pageSetupOpen, setPageSetupOpen] = useState(false);
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const [importPickerOpen, setImportPickerOpen] = useState(false);
    const [wordCountOpen, setWordCountOpen] = useState(false);
    const [restartNumberingOpen, setRestartNumberingOpen] = useState(false);
    const active = useToolbarState(editor);
    // A range of mixed alignments checks no Align item, and its trigger draws Left's icon.
    const AlignmentIcon = ALIGNMENT_LOOK[active.alignment ?? 'left'].icon;
    const { exportPath, isExporting } = useDocumentExport();
    // The icon row folds from its right end, as Google's does, so its order is its priority order; all it
    // folds stays in Format and Insert. At their widest (a link in a JetBrains Mono "Normal text") its three cuts
    // sit centered beside the five menus from 997, 1179 and 1394px.
    const showsRow = useMediaQuery('(min-width: 1000px)');
    const showsMiddle = useMediaQuery('(min-width: 1200px)');
    const showsAll = useMediaQuery('(min-width: 1400px)');
    // A phone has no room for a fifth menu beside the offline badge, so Tools folds into the kebab.
    const isMobile = useIsMobile();

    // Document-level: a viewer's editor is not editable, so an editor keymap would never see the key.
    useHotkey(WORD_COUNT_HOTKEY, (e) => {
        e.preventDefault();
        setWordCountOpen(true);
    });

    const openWordCount = () => setWordCountOpen(true);

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

    // A menu item's editor command refocuses the editor a frame later; keep it there rather than let
    // Radix restore focus to the menu trigger, which would swallow the next keystrokes.
    const keepEditorFocus = (e: Event) => {
        if (editor.isFocused) e.preventDefault();
    };

    // A menu pick has no clipboard event of its own, so execCommand fires the one ⌘C and ⌘X fire, and the editor's
    // copy and cut handlers (writeDocsClipboard, then ProseMirror's) write the clipboard as they would for the keys.
    const runClipboardCommand = (command: 'copy' | 'cut') => {
        document.execCommand(command);
        editor.commands.focus();
    };

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
        editor.chain().focus().clearNodes().unsetAllMarks().run();
    };

    const handleImageFromDevice = (files: File[]) => {
        const file = files[0];
        if (file && onImageUpload) onImageUpload(file);
    };

    return (
        <>
            <CenteredToolbar
                left={
                    <div className="flex items-center">
                        <FileMenu
                            path={path}
                            canWrite={canWrite}
                            onAccessDialogOpen={onAccessDialogOpen}
                            onExport={(format) => exportPath(path, format)}
                            onImport={() => setImportPickerOpen(true)}
                            importLabel="Import docx file…"
                            createLabel="New doc"
                            createType="doc"
                        >
                            <DropdownMenuItem onClick={() => setPageSetupOpen(true)}>
                                <FileSliders className="h-4 w-4 mr-2" /> Page setup…
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={printDocument}>
                                <Printer className="h-4 w-4 mr-2" /> Print
                            </DropdownMenuItem>
                        </FileMenu>

                        <EditMenu
                            canEdit={canWrite}
                            canUndo={canUndo}
                            canRedo={canRedo}
                            onUndo={() => editor.chain().focus().undo().run()}
                            onRedo={() => editor.chain().focus().redo().run()}
                            onCloseAutoFocus={keepEditorFocus}
                            selectionItems={
                                <>
                                    <DropdownMenuItem
                                        disabled={!canWrite || active.selectionEmpty}
                                        onClick={() => runClipboardCommand('cut')}
                                    >
                                        <Scissors className="h-4 w-4 mr-2" /> Cut
                                        <DropdownMenuShortcut>{formatForDisplay('Mod+X')}</DropdownMenuShortcut>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        disabled={active.selectionEmpty}
                                        onClick={() => runClipboardCommand('copy')}
                                    >
                                        <Copy className="h-4 w-4 mr-2" /> Copy
                                        <DropdownMenuShortcut>{formatForDisplay('Mod+C')}</DropdownMenuShortcut>
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => editor.chain().focus().selectAll().run()}>
                                        <TextSelect className="h-4 w-4 mr-2" /> Select all
                                        <DropdownMenuShortcut>{formatForDisplay('Mod+A')}</DropdownMenuShortcut>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        disabled={!canWrite || active.selectionEmpty}
                                        onClick={() => editor.chain().focus().deleteSelection().run()}
                                    >
                                        <Trash2 className="h-4 w-4 mr-2" /> Delete
                                    </DropdownMenuItem>
                                </>
                            }
                        />

                        {canWrite && (
                            <>
                                <FormatMenu
                                    editor={editor}
                                    active={active}
                                    keepEditorFocus={keepEditorFocus}
                                    setTextColor={setTextColor}
                                    setHighlightColor={setHighlightColor}
                                    clearFormatting={clearFormatting}
                                    onRestartNumbering={() => setRestartNumberingOpen(true)}
                                    onPageSetup={() => setPageSetupOpen(true)}
                                    onReplaceImage={onReplaceImage}
                                />

                                <InsertMenu
                                    editor={editor}
                                    active={active}
                                    keepEditorFocus={keepEditorFocus}
                                    onLink={handleLinkOperation}
                                    onInsertImage={onImageUpload ? () => setImagePickerOpen(true) : undefined}
                                    onAddComment={onAddComment}
                                />
                            </>
                        )}

                        {!isMobile && <ToolsMenu keepEditorFocus={keepEditorFocus} onWordCount={openWordCount} />}
                    </div>
                }
                center={
                    canWrite &&
                    showsRow && (
                        <div className="flex" role="toolbar" aria-label="Formatting">
                            <ToolbarSeparator />

                            {/* Heading / paragraph selector */}
                            <StylePicker editor={editor} active={active} keepEditorFocus={keepEditorFocus} />

                            <ToolbarSeparator />

                            {/* Font family selector */}
                            <FontPicker
                                value={active.fontName}
                                onChange={(f) => editor.chain().focus().setFontFamily(f).run()}
                                onCloseAutoFocus={keepEditorFocus}
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
                                    <DropdownMenu>
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
                                        <DropdownMenuContent onCloseAutoFocus={keepEditorFocus}>
                                            <DropdownMenuRadioGroup value={active.alignment}>
                                                {TEXT_ALIGNS.map((alignment) => {
                                                    const { label, icon: Icon } = ALIGNMENT_LOOK[alignment];
                                                    return (
                                                        <DropdownMenuRadioItem
                                                            key={alignment}
                                                            value={alignment}
                                                            onSelect={() =>
                                                                editor.chain().focus().setTextAlign(alignment).run()
                                                            }
                                                        >
                                                            <Icon className="h-4 w-4" /> {label}
                                                        </DropdownMenuRadioItem>
                                                    );
                                                })}
                                            </DropdownMenuRadioGroup>
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
                                        tooltipText="Clear formatting"
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
                        mobileMenuItems={<WordCountItem onClick={openWordCount} />}
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
                            Add Link
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <PageSetupDialog
                open={pageSetupOpen}
                onOpenChange={setPageSetupOpen}
                setup={pageSetup}
                canWrite={canWrite}
                onSetupChange={onPageSetupChange}
            />

            <WordCountDialog editor={editor} open={wordCountOpen} onOpenChange={setWordCountOpen} />

            <RestartNumberingDialog
                editor={editor}
                open={restartNumberingOpen}
                onOpenChange={setRestartNumberingOpen}
            />

            <ExportProgressDialog open={isExporting} />

            <DocumentImportPicker
                path={path}
                open={importPickerOpen}
                onOpenChange={setImportPickerOpen}
                title="Import docx file"
                progressTitle="Importing docx file"
                mime={DOCX_MIME}
                accept=".docx"
            />
        </>
    );
};
