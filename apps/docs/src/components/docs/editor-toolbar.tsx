import {useRef, useState} from "react";
import {formatForDisplay} from '@tanstack/react-hotkeys';
import {Editor} from "@tiptap/react";
import {
    AlignCenter,
    AlignLeft,
    AlignRight,
    Baseline,
    Bold,
    CheckSquare,
    ChevronDown,
    Code,
    CodeXml,
    FileText,
    Folder,
    Heading1,
    Heading2,
    Heading3,
    Highlighter,
    ImagePlus,
    Italic,
    Link,
    Link2Off,
    List,
    ListOrdered,
    LucideIcon,
    MessageSquare,
    Minus,
    Pencil,
    Pilcrow,
    Printer,
    Quote,
    Redo,
    RemoveFormatting,
    Strikethrough,
    Subscript,
    Superscript,
    Table,
    Trash2,
    Type,
    Underline,
    Undo,
    UserRoundPlus,
} from "lucide-react";
import {Button} from "@workspace/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {Separator} from "@workspace/ui/components/separator";
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,} from "@workspace/ui/components/dialog";
import {Input} from "@workspace/ui/components/input";
import {Tooltip, TooltipContent, TooltipTrigger} from "@workspace/ui/components/tooltip";
import {Popover, PopoverContent, PopoverTrigger} from "@workspace/ui/components/popover";
import {printDocument} from "@workspace/ui/lib/printElement";
import {DocumentModeButton} from "@workspace/ui/components/layout/toolbar/document-mode-button";
import {DriveCreateDoc} from "@workspace/ui/components/layout/drive/drive-create-doc";
import {useRootFolder} from "@workspace/lib/drive";
import {useAuth} from "@workspace/lib/auth";
import {DrivePath} from "@workspace/lib/types/drive";
import {useNavigate} from '@tanstack/react-router';
import {useIsMobile} from "@workspace/lib/media";
import {DriveRenameItem} from "@workspace/ui/components/layout/drive/drive-rename-item";

type EditorToolbarProps = {
    editor: Editor;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onDeleteDialogOpen: (open: boolean) => void;
    path: DrivePath;
    onAddComment?: () => void;
    onImageUpload?: (file: File) => void;
}

const TEXT_COLORS = [
    {label: 'Default', value: ''},
    {label: 'Gray', value: '#6b7280'},
    {label: 'Brown', value: '#92400e'},
    {label: 'Red', value: '#dc2626'},
    {label: 'Orange', value: '#ea580c'},
    {label: 'Yellow', value: '#ca8a04'},
    {label: 'Green', value: '#16a34a'},
    {label: 'Blue', value: '#2563eb'},
    {label: 'Purple', value: '#9333ea'},
    {label: 'Pink', value: '#db2777'},
];

const HIGHLIGHT_COLORS = [
    {label: 'None', value: ''},
    {label: 'Yellow', value: '#fef08a'},
    {label: 'Green', value: '#bbf7d0'},
    {label: 'Blue', value: '#bfdbfe'},
    {label: 'Purple', value: '#e9d5ff'},
    {label: 'Pink', value: '#fbcfe8'},
    {label: 'Red', value: '#fecaca'},
    {label: 'Orange', value: '#fed7aa'},
];

const FONT_FAMILIES = [
    {label: 'Default', value: ''},
    {label: 'Serif', value: 'Georgia, serif'},
    {label: 'Mono', value: '"SF Mono", "Fira Code", monospace'},
    {label: 'Sans', value: 'Inter, system-ui, sans-serif'},
];

const ToolbarSeparator = () => (<div className="h-6 w-[1px] bg-border mx-0.5 flex-shrink-0" />);

const ToolbarBtn = ({icon: Icon, tooltip, isActive, disabled, onAction, className = "h-8 w-8"}: {
    icon: LucideIcon;
    tooltip: string;
    isActive?: boolean;
    disabled?: boolean;
    onAction: () => void;
    className?: string;
}) => (
    <Tooltip>
        <TooltipTrigger asChild>
            <Button
                variant={isActive ? "secondary" : "ghost"}
                size="icon"
                className={className}
                disabled={disabled}
                onMouseDown={(e) => {
                    e.preventDefault();
                    onAction();
                }}
            >
                <Icon className="h-4 w-4" />
            </Button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
);

export const EditorToolbar = ({editor, path, canWrite, onAccessDialogOpen, onDeleteDialogOpen, onAddComment, onImageUpload}: EditorToolbarProps) => {
    const [linkUrl, setLinkUrl] = useState('');
    const [linkDialogOpen, setLinkDialogOpen] = useState(false);
    const [createDocOpen, setCreateDocOpen] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const {user} = useAuth();
    const {data: rootFolder} = useRootFolder(user?.id || '');
    const navigate = useNavigate();
    const isMobile = useIsMobile();

    const handleLinkOperation = () => {
        if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
        } else {
            setLinkDialogOpen(true);
        }
    };

    const applyLink = () => {
        if (!linkUrl) return;
        editor.chain().focus().setLink({href: linkUrl}).run();
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

    const activeHeadingLabel = editor.isActive('heading', {level: 1})
        ? 'Heading 1'
        : editor.isActive('heading', {level: 2})
            ? 'Heading 2'
            : editor.isActive('heading', {level: 3})
                ? 'Heading 3'
                : 'Normal';

    return (
        <div className="bg-white flex flex-col border-b no-print">
            {/* Top row: File menu + actions */}
            <div className="h-10 flex items-center justify-between px-2 border-b border-border/50">
                <div className="flex items-center gap-0.5">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">File</Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuItem onClick={() => rootFolder && setCreateDocOpen(true)}>
                                <FileText className="w-4 h-4 mr-2" /> New document
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => navigate({to: `/`})}>
                                <Folder className="w-4 h-4 mr-2" /> Open
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => path && setRenameDialogOpen(true)}>
                                <Pencil className="w-4 h-4 mr-2" /> Rename
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={onAccessDialogOpen}>
                                <UserRoundPlus className="w-4 h-4 mr-2" /> Edit access
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={printDocument}>
                                <Printer className="w-4 h-4 mr-2" /> Print
                            </DropdownMenuItem>
                            {canWrite && (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => path && onDeleteDialogOpen(true)}>
                                        <Trash2 className="w-4 h-4 mr-2" /> Delete
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {isMobile && (
                        <>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">Edit</Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                    <DropdownMenuItem onClick={() => editor.chain().focus().undo().run()}
                                                      disabled={!editor.can().undo()}>
                                        <Undo className="w-4 h-4 mr-2" /> Undo
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().redo().run()}
                                                      disabled={!editor.can().redo()}>
                                        <Redo className="w-4 h-4 mr-2" /> Redo
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>

                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">Format</Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger><Type className="w-4 h-4 mr-2" /> Text</DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleBold().run()}>
                                                <Bold className="w-4 h-4 mr-2" /> Bold
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleItalic().run()}>
                                                <Italic className="w-4 h-4 mr-2" /> Italic
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleUnderline().run()}>
                                                <Underline className="w-4 h-4 mr-2" /> Underline
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleStrike().run()}>
                                                <Strikethrough className="w-4 h-4 mr-2" /> Strikethrough
                                            </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger><Heading2 className="w-4 h-4 mr-2" /> Heading</DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                                                <Pilcrow className="mr-2 h-4 w-4" /> Normal text
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({level: 1}).run()}>
                                                <Heading1 className="mr-2 h-4 w-4" /> Heading 1
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({level: 2}).run()}>
                                                <Heading2 className="mr-2 h-4 w-4" /> Heading 2
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({level: 3}).run()}>
                                                <Heading3 className="mr-2 h-4 w-4" /> Heading 3
                                            </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger><List className="w-4 h-4 mr-2" /> Lists</DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleBulletList().run()}>
                                                <List className="w-4 h-4 mr-2" /> Bulleted
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleOrderedList().run()}>
                                                <ListOrdered className="w-4 h-4 mr-2" /> Numbered
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleTaskList().run()}>
                                                <CheckSquare className="w-4 h-4 mr-2" /> Checklist
                                            </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={clearFormatting}>
                                        <RemoveFormatting className="w-4 h-4 mr-2" /> Clear formatting
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>

                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">Insert</Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                    <DropdownMenuItem onClick={handleLinkOperation}>
                                        <Link className="w-4 h-4 mr-2" /> Link
                                    </DropdownMenuItem>
                                    {onImageUpload && (
                                        <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                                            <ImagePlus className="w-4 h-4 mr-2" /> Image
                                        </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem onClick={() => editor.chain().focus().setHorizontalRule().run()}>
                                        <Minus className="w-4 h-4 mr-2" /> Horizontal rule
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run()}>
                                        <Table className="w-4 h-4 mr-2" /> Table
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
                                        <CodeXml className="w-4 h-4 mr-2" /> Code block
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </>
                    )}
                </div>

                <div className="flex items-center gap-0.5">
                    {onAddComment && (
                        <ToolbarBtn icon={MessageSquare} tooltip="Add comment" onAction={onAddComment} />
                    )}
                    {canWrite ? (
                        <ToolbarBtn icon={UserRoundPlus} tooltip="Share" onAction={onAccessDialogOpen} />
                    ) : (
                        <DocumentModeButton canWrite={canWrite} />
                    )}
                </div>
            </div>

            {/* Bottom row: Formatting toolbar (desktop only) */}
            {canWrite && !isMobile && (
                <div className="h-10 flex items-center gap-0.5 px-2 overflow-x-auto">
                    {/* Undo / Redo */}
                    <ToolbarBtn
                        icon={Undo}
                        tooltip={`Undo (${formatForDisplay('Mod+Z')})`}
                        disabled={!editor.can().undo()}
                        onAction={() => editor.chain().focus().undo().run()}
                    />
                    <ToolbarBtn
                        icon={Redo}
                        tooltip={`Redo (${formatForDisplay('Mod+Y')})`}
                        disabled={!editor.can().redo()}
                        onAction={() => editor.chain().focus().redo().run()}
                    />

                    <ToolbarSeparator />

                    {/* Font family */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs gap-1 min-w-[70px]"
                                    onMouseDown={(e) => e.preventDefault()}>
                                <Type className="h-3.5 w-3.5" />
                                <span className="max-w-[60px] truncate">
                                    {FONT_FAMILIES.find(f => f.value && editor.isActive('textStyle', {fontFamily: f.value}))?.label || 'Default'}
                                </span>
                                <ChevronDown className="h-3 w-3" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                            {FONT_FAMILIES.map((font) => (
                                <DropdownMenuItem
                                    key={font.label}
                                    onClick={() => font.value
                                        ? editor.chain().focus().setFontFamily(font.value).run()
                                        : editor.chain().focus().unsetFontFamily().run()
                                    }
                                    style={{fontFamily: font.value || undefined}}
                                >
                                    {font.label}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Heading / paragraph selector */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs gap-1 min-w-[90px]"
                                    onMouseDown={(e) => e.preventDefault()}>
                                {activeHeadingLabel}
                                <ChevronDown className="h-3 w-3" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                            <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                                <Pilcrow className="mr-2 h-4 w-4" /> Normal text
                            </DropdownMenuItem>
                            <Separator className="my-1" />
                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({level: 1}).run()}>
                                <Heading1 className="mr-2 h-4 w-4" /> <span className="text-xl font-bold">Heading 1</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({level: 2}).run()}>
                                <Heading2 className="mr-2 h-4 w-4" /> <span className="text-lg font-semibold">Heading 2</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({level: 3}).run()}>
                                <Heading3 className="mr-2 h-4 w-4" /> <span className="text-base font-semibold">Heading 3</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <ToolbarSeparator />

                    {/* Text formatting */}
                    <ToolbarBtn
                        icon={Bold}
                        tooltip={`Bold (${formatForDisplay('Mod+B')})`}
                        isActive={editor.isActive('bold')}
                        onAction={() => editor.chain().focus().toggleBold().run()}
                    />
                    <ToolbarBtn
                        icon={Italic}
                        tooltip={`Italic (${formatForDisplay('Mod+I')})`}
                        isActive={editor.isActive('italic')}
                        onAction={() => editor.chain().focus().toggleItalic().run()}
                    />
                    <ToolbarBtn
                        icon={Underline}
                        tooltip={`Underline (${formatForDisplay('Mod+U')})`}
                        isActive={editor.isActive('underline')}
                        onAction={() => editor.chain().focus().toggleUnderline().run()}
                    />
                    <ToolbarBtn
                        icon={Strikethrough}
                        tooltip="Strikethrough"
                        isActive={editor.isActive('strike')}
                        onAction={() => editor.chain().focus().toggleStrike().run()}
                    />
                    <ToolbarBtn
                        icon={Code}
                        tooltip="Inline code"
                        isActive={editor.isActive('code')}
                        onAction={() => editor.chain().focus().toggleCode().run()}
                    />
                    <ToolbarBtn
                        icon={Superscript}
                        tooltip="Superscript"
                        isActive={editor.isActive('superscript')}
                        onAction={() => editor.chain().focus().toggleSuperscript().run()}
                    />
                    <ToolbarBtn
                        icon={Subscript}
                        tooltip="Subscript"
                        isActive={editor.isActive('subscript')}
                        onAction={() => editor.chain().focus().toggleSubscript().run()}
                    />

                    <ToolbarSeparator />

                    {/* Text color */}
                    <Popover>
                        <PopoverTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8"
                                    onMouseDown={(e) => e.preventDefault()}>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <div className="flex flex-col items-center">
                                            <Baseline className="h-4 w-4" />
                                            <div className="h-0.5 w-4 rounded-full mt-px"
                                                 style={{backgroundColor: editor.getAttributes('textStyle').color || '#000'}} />
                                        </div>
                                    </TooltipTrigger>
                                    <TooltipContent>Text color</TooltipContent>
                                </Tooltip>
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-2" align="start">
                            <div className="color-picker-grid">
                                {TEXT_COLORS.map((color) => (
                                    <button
                                        key={color.label}
                                        title={color.label}
                                        className={editor.getAttributes('textStyle').color === color.value ? 'active' : ''}
                                        style={{backgroundColor: color.value || '#000'}}
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            if (color.value) {
                                                editor.chain().focus().setColor(color.value).run();
                                            } else {
                                                editor.chain().focus().unsetColor().run();
                                            }
                                        }}
                                    />
                                ))}
                            </div>
                        </PopoverContent>
                    </Popover>

                    {/* Highlight color */}
                    <Popover>
                        <PopoverTrigger asChild>
                            <Button variant={editor.isActive('highlight') ? "secondary" : "ghost"}
                                    size="icon" className="h-8 w-8"
                                    onMouseDown={(e) => e.preventDefault()}>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Highlighter className="h-4 w-4" />
                                    </TooltipTrigger>
                                    <TooltipContent>Highlight</TooltipContent>
                                </Tooltip>
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-2" align="start">
                            <div className="color-picker-grid">
                                {HIGHLIGHT_COLORS.map((color) => (
                                    <button
                                        key={color.label}
                                        title={color.label}
                                        className={color.value && editor.isActive('highlight', {color: color.value}) ? 'active' : ''}
                                        style={{backgroundColor: color.value || '#fff', border: !color.value ? '1px solid #d1d5db' : undefined}}
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            if (color.value) {
                                                editor.chain().focus().toggleHighlight({color: color.value}).run();
                                            } else {
                                                editor.chain().focus().unsetHighlight().run();
                                            }
                                        }}
                                    />
                                ))}
                            </div>
                        </PopoverContent>
                    </Popover>

                    <ToolbarSeparator />

                    {/* Alignment */}
                    <ToolbarBtn
                        icon={AlignLeft}
                        tooltip="Align left"
                        isActive={editor.isActive({textAlign: 'left'})}
                        onAction={() => editor.chain().focus().setTextAlign('left').run()}
                    />
                    <ToolbarBtn
                        icon={AlignCenter}
                        tooltip="Align center"
                        isActive={editor.isActive({textAlign: 'center'})}
                        onAction={() => editor.chain().focus().setTextAlign('center').run()}
                    />
                    <ToolbarBtn
                        icon={AlignRight}
                        tooltip="Align right"
                        isActive={editor.isActive({textAlign: 'right'})}
                        onAction={() => editor.chain().focus().setTextAlign('right').run()}
                    />

                    <ToolbarSeparator />

                    {/* Lists */}
                    <ToolbarBtn
                        icon={List}
                        tooltip="Bulleted list"
                        isActive={editor.isActive('bulletList')}
                        onAction={() => editor.chain().focus().toggleBulletList().run()}
                    />
                    <ToolbarBtn
                        icon={ListOrdered}
                        tooltip="Numbered list"
                        isActive={editor.isActive('orderedList')}
                        onAction={() => editor.chain().focus().toggleOrderedList().run()}
                    />
                    <ToolbarBtn
                        icon={CheckSquare}
                        tooltip="Checklist"
                        isActive={editor.isActive('taskList')}
                        onAction={() => editor.chain().focus().toggleTaskList().run()}
                    />

                    <ToolbarSeparator />

                    {/* Block elements */}
                    <ToolbarBtn
                        icon={Quote}
                        tooltip="Blockquote"
                        isActive={editor.isActive('blockquote')}
                        onAction={() => editor.chain().focus().toggleBlockquote().run()}
                    />
                    <ToolbarBtn
                        icon={CodeXml}
                        tooltip="Code block"
                        isActive={editor.isActive('codeBlock')}
                        onAction={() => editor.chain().focus().toggleCodeBlock().run()}
                    />
                    <ToolbarBtn
                        icon={Minus}
                        tooltip="Horizontal rule"
                        onAction={() => editor.chain().focus().setHorizontalRule().run()}
                    />

                    <ToolbarSeparator />

                    {/* Insert actions */}
                    <ToolbarBtn
                        icon={Link}
                        tooltip="Add link"
                        isActive={editor.isActive('link')}
                        onAction={handleLinkOperation}
                    />
                    {editor.isActive('link') && (
                        <ToolbarBtn
                            icon={Link2Off}
                            tooltip="Remove link"
                            onAction={() => editor.chain().focus().unsetLink().run()}
                        />
                    )}

                    {/* Table */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant={editor.isActive('table') ? "secondary" : "ghost"}
                                    size="icon" className="h-8 w-8"
                                    onMouseDown={(e) => e.preventDefault()}>
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
                                <DropdownMenuItem onClick={() => editor.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run()}>
                                    Insert 3×3 table
                                </DropdownMenuItem>
                            ) : (
                                <>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().addColumnAfter().run()}>
                                        Add column after
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().addColumnBefore().run()}>
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
                                    <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeaderRow().run()}>
                                        Toggle header row
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().mergeCells().run()}>
                                        Merge cells
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().splitCell().run()}>
                                        Split cell
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => editor.chain().focus().deleteTable().run()}
                                                      className="text-destructive">
                                        Delete table
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Image upload */}
                    {onImageUpload && (
                        <ToolbarBtn
                            icon={ImagePlus}
                            tooltip="Insert image"
                            onAction={() => imageInputRef.current?.click()}
                        />
                    )}

                    <ToolbarSeparator />

                    {/* Clear formatting */}
                    <ToolbarBtn
                        icon={RemoveFormatting}
                        tooltip="Clear formatting"
                        onAction={clearFormatting}
                    />
                </div>
            )}

            {/* Hidden file input for image uploads */}
            <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageSelect}
            />

            {/* Dialogs */}
            {path && (
                <DriveRenameItem
                    path={path}
                    open={renameDialogOpen}
                    onOpenChange={setRenameDialogOpen}
                />
            )}
            {rootFolder && (
                <DriveCreateDoc
                    path={rootFolder}
                    open={createDocOpen}
                    onOpenChange={setCreateDocOpen}
                />
            )}
            <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>Add link</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Input
                                id="link"
                                autoFocus
                                placeholder="https://example.com"
                                value={linkUrl}
                                onChange={e => setLinkUrl(e.target.value)}
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
                        <Button type="button" variant="secondary" onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={applyLink}>Save</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
};

export default EditorToolbar;

