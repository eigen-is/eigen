import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { EIGEN_FONTS, getFontFamily } from '@workspace/lib/constants/fonts';
import { useMediaQuery } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Toolbar, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
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
import { DriveCreateDoc } from '@workspace/ui/components/layout/drive/drive-create-doc';
import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { FontPicker } from '@workspace/ui/components/layout/media/font-picker';
import { DocumentModeButton } from '@workspace/ui/components/layout/toolbar/document-mode-button';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Separator } from '@workspace/ui/components/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
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
    MessageSquare,
    Minus,
    Pilcrow,
    Printer,
    Quote,
    Redo,
    RemoveFormatting,
    Strikethrough,
    Subscript,
    Superscript,
    Table,
    Type,
    Underline,
    Undo,
    UserRoundPlus,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

type EditorToolbarProps = {
    editor: Editor;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    path: DrivePath;
    onAddComment?: () => void;
    onImageUpload?: (file: File) => void;
};

const ToolbarSeparator = () => <Separator orientation="vertical" className="h-6 mx-1" />;

export const EditorToolbar = ({
    editor,
    path,
    canWrite,
    onAccessDialogOpen,
    onAddComment,
    onImageUpload,
}: EditorToolbarProps) => {
    const [linkUrl, setLinkUrl] = useState('');
    const [linkDialogOpen, setLinkDialogOpen] = useState(false);
    const [textColorOpen, setTextColorOpen] = useState(false);
    const [highlightColorOpen, setHighlightColorOpen] = useState(false);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const isMobile = useMediaQuery('(max-width: 1200px)');

    const handleRestore = (state: Uint8Array) => {
        const tempDoc = new Y.Doc();
        Y.applyUpdate(tempDoc, state);
        const json = yDocToProsemirrorJSON(tempDoc, 'default');
        editor.commands.setContent(json);
        tempDoc.destroy();
    };

    const handleLinkOperation = () => {
        if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
        } else {
            setLinkDialogOpen(true);
        }
    };

    const applyLink = () => {
        if (!linkUrl) return;
        editor.chain().focus().setLink({ href: linkUrl }).run();
        setLinkUrl('');
        setLinkDialogOpen(false);
    };

    const clearFormatting = () => {
        editor.chain().focus().clearNodes().unsetAllMarks().run();
    };

    const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file && onImageUpload) {
            onImageUpload(file);
        }
        e.target.value = '';
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

    return (
        <Toolbar>
            <div className="flex items-center">
                <FileMenu
                    path={path}
                    canWrite={canWrite}
                    onAccessDialogOpen={onAccessDialogOpen}
                    onRestore={handleRestore}
                    createLabel="New document"
                    CreateDialog={DriveCreateDoc}
                >
                    <DropdownMenuItem onClick={printDocument}>
                        <Printer className="h-4 w-4 mr-2" /> Print
                    </DropdownMenuItem>
                </FileMenu>

                {isMobile && (
                    <>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost">Edit</Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem
                                    onClick={() => editor.chain().focus().undo().run()}
                                    disabled={!editor.can().undo()}
                                >
                                    <Undo className="h-4 w-4 mr-2" /> Undo
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() => editor.chain().focus().redo().run()}
                                    disabled={!editor.can().redo()}
                                >
                                    <Redo className="h-4 w-4 mr-2" /> Redo
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost">Format</Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuSub>
                                    <DropdownMenuSubTrigger>
                                        <Type className="h-4 w-4 mr-2" /> Font
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent>
                                        {EIGEN_FONTS.map((font) => (
                                            <DropdownMenuItem
                                                key={font.name}
                                                onClick={() =>
                                                    editor.chain().focus().setFontFamily(getFontFamily(font.name)).run()
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
                                        <DropdownMenuItem onClick={() => editor.chain().focus().toggleItalic().run()}>
                                            <Italic className="h-4 w-4 mr-2" /> Italic
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onClick={() => editor.chain().focus().toggleUnderline().run()}
                                        >
                                            <Underline className="h-4 w-4 mr-2" /> Underline
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().toggleStrike().run()}>
                                            <Strikethrough className="h-4 w-4 mr-2" /> Strikethrough
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().toggleSmall().run()}>
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
                                        <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
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
                                        <DropdownMenuItem onClick={() => editor.chain().focus().toggleTaskList().run()}>
                                            <CheckSquare className="h-4 w-4 mr-2" /> Checklist
                                        </DropdownMenuItem>
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={clearFormatting}>
                                    <RemoveFormatting className="h-4 w-4 mr-2" /> Clear formatting
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost">Insert</Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem onClick={handleLinkOperation}>
                                    <Link className="h-4 w-4 mr-2" /> Link
                                </DropdownMenuItem>
                                {onImageUpload && (
                                    <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
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
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </>
                )}
                {canWrite && !isMobile && (
                    <div className="flex items-center">
                        <TooltipButton
                            icon={Undo}
                            tooltipText={`Undo (${formatForDisplay('Mod+Z')})`}
                            disabled={!editor.can().undo()}
                            onClick={() => editor.chain().focus().undo().run()}
                        />
                        <TooltipButton
                            icon={Redo}
                            tooltipText={`Redo (${formatForDisplay('Mod+Y')})`}
                            disabled={!editor.can().redo()}
                            onClick={() => editor.chain().focus().redo().run()}
                        />
                    </div>
                )}
            </div>

            {/* Bottom row: Formatting toolbar (desktop only) */}
            {canWrite && !isMobile && (
                <div className="flex">
                    <ToolbarSeparator />

                    {/* Font family selector */}
                    <FontPicker
                        value={(() => {
                            const ff = editor.getAttributes('textStyle').fontFamily || '';
                            const match = ff.match(/^'([^']+)'/);
                            return match ? match[1] : 'Inter';
                        })()}
                        onChange={(f) => editor.chain().focus().setFontFamily(getFontFamily(f)).run()}
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
                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
                                <Heading1 className="mr-2 h-4 w-4" />{' '}
                                <span className="text-xl font-bold">Heading 1</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
                                <Heading2 className="mr-2 h-4 w-4" />{' '}
                                <span className="text-lg font-semibold">Heading 2</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
                                <Heading3 className="mr-2 h-4 w-4" />{' '}
                                <span className="text-base font-semibold">Heading 3</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}>
                                <Heading4 className="mr-2 h-4 w-4" />{' '}
                                <span className="text-sm font-semibold">Heading 4</span>
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
                    <Popover open={textColorOpen} onOpenChange={setTextColorOpen}>
                        <PopoverTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <div className="flex flex-col items-center">
                                            <Baseline className="h-4 w-4" />
                                            <div
                                                className="h-0.5 w-4 rounded-full mt-px"
                                                style={{
                                                    backgroundColor:
                                                        editor.getAttributes('textStyle').color || 'currentColor',
                                                }}
                                            />
                                        </div>
                                    </TooltipTrigger>
                                    <TooltipContent>Text color</TooltipContent>
                                </Tooltip>
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-3" align="start">
                            <ColorPicker
                                value={editor.getAttributes('textStyle').color || ''}
                                resetLabel="Default"
                                preventFocusLoss
                                onChange={(color) => {
                                    if (color) {
                                        editor.chain().focus().setColor(color).run();
                                    } else {
                                        editor.chain().focus().unsetColor().run();
                                    }
                                    setTextColorOpen(false);
                                }}
                            />
                        </PopoverContent>
                    </Popover>

                    {/* Highlight color */}
                    <Popover open={highlightColorOpen} onOpenChange={setHighlightColorOpen}>
                        <PopoverTrigger asChild>
                            <Button
                                variant={editor.isActive('highlight') ? 'secondary' : 'ghost'}
                                size="icon"
                                className="h-8 w-8"
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Highlighter className="h-4 w-4" />
                                    </TooltipTrigger>
                                    <TooltipContent>Highlight</TooltipContent>
                                </Tooltip>
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-3" align="start">
                            <ColorPicker
                                value={
                                    editor.isActive('highlight') ? editor.getAttributes('highlight').color || '' : ''
                                }
                                resetLabel="None"
                                preventFocusLoss
                                onChange={(color) => {
                                    if (color) {
                                        editor.chain().focus().toggleHighlight({ color }).run();
                                    } else {
                                        editor.chain().focus().unsetHighlight().run();
                                    }
                                    setHighlightColorOpen(false);
                                }}
                            />
                        </PopoverContent>
                    </Popover>

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
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant={editor.isActive('table') ? 'secondary' : 'ghost'}
                                    size="icon"
                                    className="h-8 w-8"
                                    onMouseDown={(e) => e.preventDefault()}
                                >
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Table className="h-4 w-4" />
                                        </TooltipTrigger>
                                        <TooltipContent>Table</TooltipContent>
                                    </Tooltip>
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent>
                                {!editor.isActive('table') ? (
                                    <DropdownMenuItem
                                        onClick={() =>
                                            editor
                                                .chain()
                                                .focus()
                                                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                                                .run()
                                        }
                                    >
                                        Insert 3×3 table
                                    </DropdownMenuItem>
                                ) : (
                                    <>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().addColumnAfter().run()}>
                                            Add column after
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onClick={() => editor.chain().focus().addColumnBefore().run()}
                                        >
                                            Add column before
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().deleteColumn().run()}>
                                            Delete column
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onClick={() => editor.chain().focus().addRowAfter().run()}>
                                            Add row after
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().addRowBefore().run()}>
                                            Add row before
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().deleteRow().run()}>
                                            Delete row
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            onClick={() => editor.chain().focus().toggleHeaderRow().run()}
                                        >
                                            Toggle header row
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().mergeCells().run()}>
                                            Merge cells
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().splitCell().run()}>
                                            Split cell
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            onClick={() => editor.chain().focus().deleteTable().run()}
                                            className="text-destructive"
                                        >
                                            Delete table
                                        </DropdownMenuItem>
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>

                        {/* Image upload */}
                        {onImageUpload && (
                            <TooltipButton
                                icon={ImagePlus}
                                tooltipText="Insert image"
                                onClick={() => imageInputRef.current?.click()}
                            />
                        )}

                        <TooltipButton
                            icon={RemoveFormatting}
                            tooltipText="Clear formatting"
                            onClick={clearFormatting}
                        />
                    </div>
                </div>
            )}

            <div className="flex items-center">
                {onAddComment && (
                    <TooltipButton icon={MessageSquare} tooltipText="Add comment" onClick={onAddComment} />
                )}
                {canWrite ? (
                    <TooltipButton icon={UserRoundPlus} tooltipText="Share" onClick={onAccessDialogOpen} />
                ) : (
                    <DocumentModeButton canWrite={canWrite} />
                )}
            </div>
            {/* Hidden file input for image uploads */}
            <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageSelect} />

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
        </Toolbar>
    );
};

export default EditorToolbar;
