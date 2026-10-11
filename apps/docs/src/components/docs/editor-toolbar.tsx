import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { EIGEN_FONTS, getFontFamily } from '@workspace/lib/constants/fonts';
import { DOCX_MIME } from '@workspace/lib/constants/mime';
import { useMediaQuery } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isImageMime } from '@workspace/lib/types/drive';
import { TEXT_ALIGNS, type TextAlign } from '@workspace/lib/vector';
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
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { printDocument } from '@workspace/ui/lib/printElement';
import {
    ALargeSmall,
    AlignCenter,
    AlignJustify,
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
    Heading5,
    Heading6,
    Highlighter,
    ImageIcon,
    ImagePlus,
    Italic,
    Link,
    Link2Off,
    List,
    ListOrdered,
    type LucideIcon,
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
    TypeOutline,
    Underline,
} from 'lucide-react';
import { useState } from 'react';
import { useToolbarState } from './hooks/use-toolbar-state';
import { PageSetupDialog } from './page-setup-dialog';
import { TABLE_ACTION_ICONS } from './table-action-icons';

// Format › Paragraph styles and the style picker list these; the picker previews each as the editor draws it, its
// sizes stepping down and Heading 5 and 6 at the body's weight in grey, Heading 6 in italic.
const HEADINGS = [
    { level: 1, icon: Heading1, preview: 'text-xl font-medium' },
    { level: 2, icon: Heading2, preview: 'text-lg font-medium' },
    { level: 3, icon: Heading3, preview: 'text-base font-medium' },
    { level: 4, icon: Heading4, preview: 'text-sm font-medium' },
    { level: 5, icon: Heading5, preview: 'text-sm text-muted-foreground' },
    { level: 6, icon: Heading6, preview: 'text-sm text-muted-foreground italic' },
] as const;

// Format › Align and indent and the icon row's Align dropdown name each alignment alike.
const ALIGNMENT_LOOK: Record<TextAlign, { label: string; icon: LucideIcon }> = {
    left: { label: 'Left', icon: AlignLeft },
    center: { label: 'Center', icon: AlignCenter },
    right: { label: 'Right', icon: AlignRight },
    justify: { label: 'Justified', icon: AlignJustify },
};

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
    const active = useToolbarState(editor);
    // A range of mixed alignments checks no Align item, and its trigger draws Left's icon.
    const AlignmentIcon = ALIGNMENT_LOOK[active.alignment ?? 'left'].icon;
    const { exportPath, isExporting } = useDocumentExport();
    // The icon row folds from its right end, as Google's does, so its order is its priority order; all it
    // folds stays in Format and Insert. At their widest (a link in a JetBrains Mono "Normal text") its three cuts
    // sit centered beside the menus from 870, 1052 and 1267px.
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
                            onCloseAutoFocus={keepEditorFocus}
                        />

                        {canWrite && (
                            <>
                                <ToolbarMenu label="Format" onCloseAutoFocus={keepEditorFocus}>
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
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleCode().run()}>
                                                <Code className="h-4 w-4 mr-2" /> Inline code
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleSmall().run()}
                                            >
                                                <ALargeSmall className="h-4 w-4 mr-2" /> Small
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleCaps('small').run()}
                                            >
                                                <CaseSensitive className="h-4 w-4 mr-2" /> Small caps
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleCaps('all').run()}
                                            >
                                                <CaseUpper className="h-4 w-4 mr-2" /> All caps
                                                <DropdownMenuShortcut>
                                                    {formatForDisplay('Mod+Shift+A')}
                                                </DropdownMenuShortcut>
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
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger>
                                            <TypeOutline className="h-4 w-4 mr-2" /> Font
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
                                    <DropdownMenuSeparator />
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger>
                                            <Heading2 className="h-4 w-4 mr-2" /> Paragraph styles
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().setParagraph().run()}
                                            >
                                                <Pilcrow className="mr-2 h-4 w-4" /> Normal text
                                            </DropdownMenuItem>
                                            {HEADINGS.map(({ level, icon: Icon }) => (
                                                <DropdownMenuItem
                                                    key={level}
                                                    onClick={() =>
                                                        editor.chain().focus().toggleHeading({ level }).run()
                                                    }
                                                >
                                                    <Icon className="mr-2 h-4 w-4" /> Heading {level}
                                                </DropdownMenuItem>
                                            ))}
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
                                            <AlignLeft className="h-4 w-4 mr-2" /> Align and indent
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            {TEXT_ALIGNS.map((alignment) => {
                                                const { label, icon: Icon } = ALIGNMENT_LOOK[alignment];
                                                return (
                                                    <DropdownMenuItem
                                                        key={alignment}
                                                        onClick={() =>
                                                            editor.chain().focus().setTextAlign(alignment).run()
                                                        }
                                                    >
                                                        <Icon className="h-4 w-4 mr-2" /> {label}
                                                    </DropdownMenuItem>
                                                );
                                            })}
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger>
                                            <List className="h-4 w-4 mr-2" /> Bullets and numbering
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                                            >
                                                <ListOrdered className="h-4 w-4 mr-2" /> Numbered list
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleBulletList().run()}
                                            >
                                                <List className="h-4 w-4 mr-2" /> Bulleted list
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleTaskList().run()}
                                            >
                                                <CheckSquare className="h-4 w-4 mr-2" /> Checklist
                                            </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger disabled={!active.table}>
                                            <Table className="h-4 w-4 mr-2" /> Table
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().addRowBefore().run()}
                                            >
                                                <TABLE_ACTION_ICONS.addRowBefore className="h-4 w-4 mr-2" /> Insert row
                                                above
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().addRowAfter().run()}
                                            >
                                                <TABLE_ACTION_ICONS.addRowAfter className="h-4 w-4 mr-2" /> Insert row
                                                below
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().addColumnBefore().run()}
                                            >
                                                <TABLE_ACTION_ICONS.addColumnBefore className="h-4 w-4 mr-2" /> Insert
                                                column left
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().addColumnAfter().run()}
                                            >
                                                <TABLE_ACTION_ICONS.addColumnAfter className="h-4 w-4 mr-2" /> Insert
                                                column right
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem onClick={() => editor.chain().focus().deleteRow().run()}>
                                                <TABLE_ACTION_ICONS.deleteRow className="h-4 w-4 mr-2" /> Delete row
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().deleteColumn().run()}
                                            >
                                                <TABLE_ACTION_ICONS.deleteColumn className="h-4 w-4 mr-2" /> Delete
                                                column
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().deleteTable().run()}
                                            >
                                                <TABLE_ACTION_ICONS.deleteTable className="h-4 w-4 mr-2" /> Delete table
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                disabled={!active.canMergeCells}
                                                onClick={() => editor.chain().focus().mergeCells().run()}
                                            >
                                                <TABLE_ACTION_ICONS.mergeCells className="h-4 w-4 mr-2" /> Merge cells
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                disabled={!active.canSplitCell}
                                                onClick={() => editor.chain().focus().splitCell().run()}
                                            >
                                                <TABLE_ACTION_ICONS.splitCell className="h-4 w-4 mr-2" /> Unmerge cells
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                onClick={() => editor.chain().focus().toggleHeaderRow().run()}
                                            >
                                                <TABLE_ACTION_ICONS.toggleHeaderRow className="h-4 w-4 mr-2" /> Toggle
                                                header row
                                            </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger disabled={!active.figure}>
                                            <ImageIcon className="h-4 w-4 mr-2" /> Image
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem onClick={onReplaceImage}>
                                                <ImagePlus className="h-4 w-4 mr-2" /> Replace image
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
                        <div className="flex" role="toolbar" aria-label="Formatting">
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
                                            {active.mixedStyles
                                                ? ''
                                                : active.headingLevel
                                                  ? `Heading ${active.headingLevel}`
                                                  : 'Normal text'}
                                        </span>
                                        <ChevronDown className="h-3 w-3" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent onCloseAutoFocus={keepEditorFocus}>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                                        <Pilcrow className="mr-2 h-4 w-4" /> Normal text
                                    </DropdownMenuItem>
                                    <Separator className="my-1" />
                                    {HEADINGS.map(({ level, icon: Icon, preview }) => (
                                        <DropdownMenuItem
                                            key={level}
                                            onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
                                        >
                                            <Icon className="mr-2 h-4 w-4" />{' '}
                                            <span className={preview}>Heading {level}</span>
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>

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
