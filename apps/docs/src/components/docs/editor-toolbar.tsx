import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { EIGEN_FONTS, getFontFamily, getFontName } from '@workspace/lib/constants/fonts';
import { DOCX_MIME } from '@workspace/lib/constants/mime';
import { useIsCompactToolbar } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
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
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { ColorPickerButton } from '@workspace/ui/components/media';
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
    CheckSquare,
    ChevronDown,
    Code,
    CodeXml,
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
    Strikethrough,
    Subscript,
    Superscript,
    Table,
    Type,
    Underline,
} from 'lucide-react';
import { useState } from 'react';

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
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const [importPickerOpen, setImportPickerOpen] = useState(false);
    // Controlled: useEditor skips selection-only re-renders, so opening must re-render for a live disabled check.
    const [insertMenuOpen, setInsertMenuOpen] = useState(false);
    const { exportPath, isExporting } = useDocumentExport();
    // Docs' inline toolbar is the widest in the suite (~30 controls), so it folds earlier than the
    // shared 1200px default.
    const isCompact = useIsCompactToolbar(1400);

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

    const clearFormatting = () => {
        editor.chain().focus().clearNodes().unsetAllMarks().run();
    };

    const handleImageFromDevice = (files: File[]) => {
        const file = files[0];
        if (file && onImageUpload) onImageUpload(file);
    };

    const activeHeadingLabel = editor.isActive('heading', { level: 1 })
        ? 'Heading 1'
        : editor.isActive('heading', { level: 2 })
          ? 'Heading 2'
          : editor.isActive('heading', { level: 3 })
            ? 'Heading 3'
            : editor.isActive('heading', { level: 4 })
              ? 'Heading 4'
              : 'Normal';

    // Docs stores the fontFamily attr as an EIGEN_FONTS name now; getFontName also collapses any
    // legacy full-stack value a not-yet-normalized doc still carries.
    const activeFontName = getFontName(editor.getAttributes('textStyle').fontFamily || '') || EIGEN_FONTS[0].name;

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

                        {isCompact && canWrite && (
                            <>
                                <ToolbarMenu label="Format">
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

                                <ToolbarMenu label="Insert" open={insertMenuOpen} onOpenChange={setInsertMenuOpen}>
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
                                            <DropdownMenuItem
                                                disabled={editor.state.selection.empty}
                                                onClick={onAddComment}
                                            >
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
                    !isCompact && (
                        <div className="flex">
                            <ToolbarSeparator />

                            {/* Font family selector */}
                            <FontPicker
                                value={activeFontName}
                                onChange={(f) => editor.chain().focus().setFontFamily(f).run()}
                            />

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
                                        <span className="text-xs whitespace-nowrap">{activeHeadingLabel}</span>
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

                            {/* Text formatting toggle group */}
                            <div className="flex items-center gap-0.5">
                                <TooltipButton
                                    icon={Bold}
                                    tooltipText={`Bold (${formatForDisplay('Mod+B')})`}
                                    active={editor.isActive('bold')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleBold().run()}
                                />
                                <TooltipButton
                                    icon={Italic}
                                    tooltipText={`Italic (${formatForDisplay('Mod+I')})`}
                                    active={editor.isActive('italic')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleItalic().run()}
                                />
                                <TooltipButton
                                    icon={Underline}
                                    tooltipText={`Underline (${formatForDisplay('Mod+U')})`}
                                    active={editor.isActive('underline')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleUnderline().run()}
                                />
                                <TooltipButton
                                    icon={Strikethrough}
                                    tooltipText="Strikethrough"
                                    active={editor.isActive('strike')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleStrike().run()}
                                />
                                <TooltipButton
                                    icon={Code}
                                    tooltipText="Inline code"
                                    active={editor.isActive('code')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleCode().run()}
                                />
                                <TooltipButton
                                    icon={Superscript}
                                    tooltipText="Superscript"
                                    active={editor.isActive('superscript')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleSuperscript().run()}
                                />
                                <TooltipButton
                                    icon={Subscript}
                                    tooltipText="Subscript"
                                    active={editor.isActive('subscript')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleSubscript().run()}
                                />
                                <TooltipButton
                                    icon={ALargeSmall}
                                    tooltipText="Small"
                                    active={editor.isActive('small')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleSmall().run()}
                                />
                            </div>

                            <ToolbarSeparator />

                            {/* Text color */}
                            <ColorPickerButton
                                icon={Baseline}
                                tooltipText="Text color"
                                value={editor.getAttributes('textStyle').color || ''}
                                resetLabel="Default"
                                showSwatch
                                onChange={(color) => {
                                    if (color) {
                                        editor.chain().focus().setColor(color).run();
                                    } else {
                                        editor.chain().focus().unsetColor().run();
                                    }
                                }}
                            />

                            {/* Highlight color */}
                            <ColorPickerButton
                                icon={Highlighter}
                                tooltipText="Highlight"
                                active={editor.isActive('highlight')}
                                value={
                                    editor.isActive('highlight') ? editor.getAttributes('highlight').color || '' : ''
                                }
                                resetLabel="None"
                                onChange={(color) => {
                                    if (color) {
                                        editor.chain().focus().toggleHighlight({ color }).run();
                                    } else {
                                        editor.chain().focus().unsetHighlight().run();
                                    }
                                }}
                            />

                            <ToolbarSeparator />

                            {/* Alignment toggle group */}
                            <div className="flex items-center gap-0.5">
                                <TooltipButton
                                    icon={AlignLeft}
                                    tooltipText="Align left"
                                    active={editor.isActive({ textAlign: 'left' })}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().setTextAlign('left').run()}
                                />
                                <TooltipButton
                                    icon={AlignCenter}
                                    tooltipText="Align center"
                                    active={editor.isActive({ textAlign: 'center' })}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().setTextAlign('center').run()}
                                />
                                <TooltipButton
                                    icon={AlignRight}
                                    tooltipText="Align right"
                                    active={editor.isActive({ textAlign: 'right' })}
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
                                    active={editor.isActive('bulletList')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleBulletList().run()}
                                />
                                <TooltipButton
                                    icon={ListOrdered}
                                    tooltipText="Numbered list"
                                    active={editor.isActive('orderedList')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleOrderedList().run()}
                                />
                                <TooltipButton
                                    icon={CheckSquare}
                                    tooltipText="Checklist"
                                    active={editor.isActive('taskList')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleTaskList().run()}
                                />
                            </div>

                            <ToolbarSeparator />

                            {/* Block elements */}
                            <div className="flex items-center gap-0.5">
                                <TooltipButton
                                    icon={Quote}
                                    tooltipText="Blockquote"
                                    active={editor.isActive('blockquote')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleBlockquote().run()}
                                />
                                <TooltipButton
                                    icon={CodeXml}
                                    tooltipText="Code block"
                                    active={editor.isActive('codeBlock')}
                                    preventFocusLoss
                                    onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                                />
                            </div>
                            <TooltipButton
                                icon={Minus}
                                tooltipText="Horizontal rule"
                                preventFocusLoss
                                onClick={() => editor.chain().focus().setHorizontalRule().run()}
                            />

                            <ToolbarSeparator />

                            {/* Insert actions */}
                            <div className="flex items-center gap-0.5">
                                <TooltipButton
                                    icon={Link}
                                    tooltipText="Add link"
                                    active={editor.isActive('link')}
                                    preventFocusLoss
                                    onClick={handleLinkOperation}
                                />
                                {editor.isActive('link') && (
                                    <TooltipButton
                                        icon={Link2Off}
                                        tooltipText="Remove link"
                                        preventFocusLoss
                                        onClick={() => editor.chain().focus().unsetLink().run()}
                                    />
                                )}

                                {/* Table */}
                                <TooltipButton
                                    icon={Table}
                                    tooltipText="Insert table"
                                    preventFocusLoss
                                    onClick={() =>
                                        editor
                                            .chain()
                                            .focus()
                                            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                                            .run()
                                    }
                                />

                                {/* Image upload */}
                                {onImageUpload && (
                                    <TooltipButton
                                        icon={ImagePlus}
                                        tooltipText="Insert image"
                                        onClick={() => setImagePickerOpen(true)}
                                    />
                                )}

                                <TooltipButton
                                    icon={RemoveFormatting}
                                    tooltipText="Clear formatting"
                                    onClick={clearFormatting}
                                />
                            </div>
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
                    mimeFilter={['image/*']}
                    onPickFromDrive={(paths) => onImagePickFromDrive?.(paths)}
                    onPickFromDevice={handleImageFromDevice}
                    accept="image/*"
                />
            )}

            <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
                <DialogContent size="sm">
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

            <ExportProgressDialog open={isExporting} />

            <DocumentImportPicker
                path={path}
                open={importPickerOpen}
                onOpenChange={setImportPickerOpen}
                title="Import docx file"
                mime={DOCX_MIME}
                accept=".docx"
            />
        </>
    );
};
