import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { EIGEN_FONTS, getFontFamily } from '@workspace/lib/constants/fonts';
import { DOCX_MIME } from '@workspace/lib/constants/mime';
import { useMediaQuery } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isImageMime } from '@workspace/lib/types/drive';
import {
    CenteredToolbar,
    DocumentShareCluster,
    EditMenu,
    FileMenu,
    ToolbarMenu,
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
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { ColorPickerButton, ColorPickerMenuItem } from '@workspace/ui/components/media';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import { Separator } from '@workspace/ui/components/separator';
import { printDocument } from '@workspace/ui/lib/printElement';
import {
    ALargeSmall,
    AlignCenter,
    AlignLeft,
    AlignRight,
    Baseline,
    Bold,
    CaseSensitive,
    CaseUpper,
    CheckSquare,
    ChevronDown,
    Code,
    CodeXml,
    FileSliders,
    Heading1,
    Heading2,
    Heading3,
    Heading4,
    Highlighter,
    ImagePlus,
    Italic,
    Link,
    Link2Off,
    List,
    ListOrdered,
    MessageSquarePlus,
    Minus,
    Pilcrow,
    Printer,
    Quote,
    RemoveFormatting,
    SeparatorHorizontal,
    Strikethrough,
    Subscript,
    Superscript,
    Table,
    Type,
    Underline,
} from 'lucide-react';
import { useState } from 'react';
import { useToolbarState } from './hooks/use-toolbar-state';
import { PageSetupDialog } from './page-setup-dialog';

type EditorToolbarProps = {
    editor: Editor;
    canWrite: boolean;
    offline: boolean;
    storageUnavailable: boolean;
    canUndo: boolean;
    canRedo: boolean;
    onAccessDialogOpen: () => void;
    path: DrivePath;
    onToggleCommentPanel?: () => void;
    commentPanelOpen?: boolean;
    onToggleActivityPanel?: () => void;
    activityPanelOpen?: boolean;
    assignedCommentCount?: number;
    onImageUpload?: (file: File) => void;
    onImagePickFromDrive?: (paths: DrivePath[]) => void;
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
    onAccessDialogOpen,
    onToggleCommentPanel,
    commentPanelOpen,
    onToggleActivityPanel,
    activityPanelOpen,
    assignedCommentCount,
    onImageUpload,
    onImagePickFromDrive,
    onAddComment,
}: EditorToolbarProps) => {
    const [linkUrl, setLinkUrl] = useState('');
    const [linkDialogOpen, setLinkDialogOpen] = useState(false);
    const [pageSetupOpen, setPageSetupOpen] = useState(false);
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const [importPickerOpen, setImportPickerOpen] = useState(false);
    const active = useToolbarState(editor);
    const { exportPath, isExporting } = useDocumentExport();
    // The icon row folds from its right end, as Google's does, so its order is its priority order; all it
    // folds stays in Format and Insert. At their widest (a link in a JetBrains Mono "Heading 4") its three cuts
    // sit centered beside the menus from 862, 1044 and 1303px.
    const showsRow = useMediaQuery('(min-width: 900px)');
    const showsMiddle = useMediaQuery('(min-width: 1100px)');
    const showsAll = useMediaQuery('(min-width: 1400px)');

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
                        />

                        {canWrite && (
                            <>
                                <ToolbarMenu label="Format" onCloseAutoFocus={keepEditorFocus}>
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger>
                                            <Type className="h-4 w-4 mr-2" /> Font
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            {EIGEN_FONTS.map((font) => (
                                                <DropdownMenuItem
                                                    key={font.name}
                                                    onClick={() =>
                                                        editor.chain().focus().setFontFamily(font.name).run()
                                                    }
                                                >
                                                    <span style={{ fontFamily: getFontFamily(font.name) }}>
                                                        {font.name}
                                                    </span>
                                                </DropdownMenuItem>
                                            ))}
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger>
                                            <Type className="h-4 w-4 mr-2" /> Text
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleBold().run()}>
                                                <Bold className="h-4 w-4 mr-2" /> Bold
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleItalic().run()}
                                            >
                                                <Italic className="h-4 w-4 mr-2" /> Italic
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleUnderline().run()}
                                            >
                                                <Underline className="h-4 w-4 mr-2" /> Underline
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleStrike().run()}
                                            >
                                                <Strikethrough className="h-4 w-4 mr-2" /> Strikethrough
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleCode().run()}>
                                                <Code className="h-4 w-4 mr-2" /> Inline code
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleSuperscript().run()}
                                            >
                                                <Superscript className="h-4 w-4 mr-2" /> Superscript
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleSubscript().run()}
                                            >
                                                <Subscript className="h-4 w-4 mr-2" /> Subscript
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleSmall().run()}
                                            >
                                                <ALargeSmall className="h-4 w-4 mr-2" /> Small
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleCaps('all').run()}
                                            >
                                                <CaseUpper className="h-4 w-4 mr-2" /> All caps
                                                <DropdownMenuShortcut>
                                                    {formatForDisplay('Mod+Shift+A')}
                                                </DropdownMenuShortcut>
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleCaps('small').run()}
                                            >
                                                <CaseSensitive className="h-4 w-4 mr-2" /> Small caps
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <ColorPickerMenuItem
                                                icon={Baseline}
                                                label="Text color"
                                                value={active.color}
                                                resetLabel="Default"
                                                onChange={setTextColor}
                                            />
                                            <ColorPickerMenuItem
                                                icon={Highlighter}
                                                label="Highlight color"
                                                value={active.highlightColor}
                                                resetLabel="None"
                                                onChange={setHighlightColor}
                                            />
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger>
                                            <Heading2 className="h-4 w-4 mr-2" /> Heading
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().setParagraph().run()}
                                            >
                                                <Pilcrow className="mr-2 h-4 w-4" /> Normal text
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                                            >
                                                <Heading1 className="mr-2 h-4 w-4" /> Heading 1
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                                            >
                                                <Heading2 className="mr-2 h-4 w-4" /> Heading 2
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                                            >
                                                <Heading3 className="mr-2 h-4 w-4" /> Heading 3
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
                                            >
                                                <Heading4 className="mr-2 h-4 w-4" /> Heading 4
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleBlockquote().run()}
                                            >
                                                <Quote className="mr-2 h-4 w-4" /> Quote
                                            </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger>
                                            <AlignLeft className="h-4 w-4 mr-2" /> Align
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().setTextAlign('left').run()}
                                            >
                                                <AlignLeft className="h-4 w-4 mr-2" /> Left
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().setTextAlign('center').run()}
                                            >
                                                <AlignCenter className="h-4 w-4 mr-2" /> Center
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().setTextAlign('right').run()}
                                            >
                                                <AlignRight className="h-4 w-4 mr-2" /> Right
                                            </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger>
                                            <List className="h-4 w-4 mr-2" /> Lists
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleBulletList().run()}
                                            >
                                                <List className="h-4 w-4 mr-2" /> Bulleted
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                                            >
                                                <ListOrdered className="h-4 w-4 mr-2" /> Numbered
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleTaskList().run()}
                                            >
                                                <CheckSquare className="h-4 w-4 mr-2" /> Checklist
                                            </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={clearFormatting}>
                                        <RemoveFormatting className="h-4 w-4 mr-2" /> Clear formatting
                                    </DropdownMenuItem>
                                </ToolbarMenu>

                                <ToolbarMenu label="Insert" onCloseAutoFocus={keepEditorFocus}>
                                    <DropdownMenuItem onClick={handleLinkOperation}>
                                        <Link className="h-4 w-4 mr-2" /> Link
                                    </DropdownMenuItem>
                                    {onImageUpload && (
                                        <DropdownMenuItem onClick={() => setImagePickerOpen(true)}>
                                            <ImagePlus className="h-4 w-4 mr-2" /> Image
                                        </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem onClick={() => editor.chain().focus().setHorizontalRule().run()}>
                                        <Minus className="h-4 w-4 mr-2" /> Horizontal rule
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().setPageBreak().run()}>
                                        <SeparatorHorizontal className="h-4 w-4 mr-2" /> Page break
                                        <DropdownMenuShortcut>{formatForDisplay('Mod+Enter')}</DropdownMenuShortcut>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() =>
                                            editor
                                                .chain()
                                                .focus()
                                                .insertTable({
                                                    rows: 3,
                                                    cols: 3,
                                                    withHeaderRow: true,
                                                })
                                                .run()
                                        }
                                    >
                                        <Table className="h-4 w-4 mr-2" /> Table
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
                                        <CodeXml className="h-4 w-4 mr-2" /> Code block
                                    </DropdownMenuItem>
                                    {onAddComment && (
                                        <>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem disabled={active.selectionEmpty} onClick={onAddComment}>
                                                <MessageSquarePlus className="h-4 w-4 mr-2" /> Comment
                                            </DropdownMenuItem>
                                        </>
                                    )}
                                </ToolbarMenu>
                            </>
                        )}
                    </div>
                }
                center={
                    canWrite &&
                    showsRow && (
                        <div className="flex">
                            <ToolbarSeparator />

                            {/* Heading / paragraph selector */}
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2 gap-1"
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <span className="text-xs whitespace-nowrap">
                                            {active.headingLevel ? `Heading ${active.headingLevel}` : 'Normal'}
                                        </span>
                                        <ChevronDown className="h-3 w-3" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                                        <Pilcrow className="mr-2 h-4 w-4" /> Normal text
                                    </DropdownMenuItem>
                                    <Separator className="my-1" />
                                    <DropdownMenuItem
                                        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                                    >
                                        <Heading1 className="mr-2 h-4 w-4" />{' '}
                                        <span className="text-xl font-medium">Heading 1</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                                    >
                                        <Heading2 className="mr-2 h-4 w-4" />{' '}
                                        <span className="text-lg font-medium">Heading 2</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                                    >
                                        <Heading3 className="mr-2 h-4 w-4" />{' '}
                                        <span className="text-base font-medium">Heading 3</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
                                    >
                                        <Heading4 className="mr-2 h-4 w-4" />{' '}
                                        <span className="text-sm font-medium">Heading 4</span>
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>

                            <ToolbarSeparator />

                            {/* Font family selector */}
                            <FontPicker
                                value={active.fontName}
                                onChange={(f) => editor.chain().focus().setFontFamily(f).run()}
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
                                        tooltipText="Highlight"
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

                                    {/* Alignment toggle group */}
                                    <div className="flex items-center gap-0.5">
                                        <TooltipButton
                                            icon={AlignLeft}
                                            tooltipText="Align left"
                                            active={active.alignLeft}
                                            preventFocusLoss
                                            onClick={() => editor.chain().focus().setTextAlign('left').run()}
                                        />
                                        <TooltipButton
                                            icon={AlignCenter}
                                            tooltipText="Align center"
                                            active={active.alignCenter}
                                            preventFocusLoss
                                            onClick={() => editor.chain().focus().setTextAlign('center').run()}
                                        />
                                        <TooltipButton
                                            icon={AlignRight}
                                            tooltipText="Align right"
                                            active={active.alignRight}
                                            preventFocusLoss
                                            onClick={() => editor.chain().focus().setTextAlign('right').run()}
                                        />
                                    </div>

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

            <PageSetupDialog open={pageSetupOpen} onOpenChange={setPageSetupOpen} />

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
