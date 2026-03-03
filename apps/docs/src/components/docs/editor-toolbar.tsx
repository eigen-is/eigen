import {useEffect, useState} from "react";
import {BaseEditor, Editor, Element as SlateElement, Transforms} from "slate";
import {ReactEditor, useSlate} from "slate-react";
import {HistoryEditor} from "slate-history";
import {
    AlignCenter,
    AlignLeft,
    AlignRight,
    Bold,
    CheckSquare,
    FileText,
    Folder,
    Heading1,
    Heading2,
    Heading3,
    Italic,
    Link,
    Link2Off,
    List,
    ListOrdered,
    LucideIcon,
    MessageSquare,
    Pencil,
    Printer,
    Redo,
    RemoveFormatting,
    Strikethrough,
    Trash2,
    Type,
    Underline,
    Undo,
    UserRoundPlus
} from "lucide-react";
import {TooltipButton} from "@workspace/ui";
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
import {printDocument} from "@workspace/ui/lib/printElement";
import {CustomElement, CustomElementType, CustomText, TextAlignment} from "./editor.types";
import {DocumentModeButton} from "@workspace/ui/components/layout/toolbar/document-mode-button";
import {DriveCreateDoc} from "@workspace/ui/components/layout/drive/drive-create-doc";
import {useRootFolder} from "@workspace/lib/drive";
import {useAuth} from "@workspace/lib/auth";
import {DrivePath} from "@workspace/lib/types/drive";
import {useNavigate} from '@tanstack/react-router';
import {useIsMobile} from "@workspace/lib/media";
import {DriveRenameItem} from "@workspace/ui/components/layout/drive/drive-rename-item";

type CustomEditor = BaseEditor & ReactEditor & HistoryEditor;

declare module 'slate' {
    interface CustomTypes {
        Editor: CustomEditor;
        Element: CustomElement;
        Text: CustomText;
    }
}

const isMarkActive = (editor: CustomEditor, format: keyof Omit<CustomText, 'text'>) => {
    const marks = Editor.marks(editor);
    return marks ? marks[format] === true : false;
};

const toggleMark = (editor: CustomEditor, format: keyof Omit<CustomText, 'text'>) => {
    const isActive = isMarkActive(editor, format);

    if (isActive) {
        Editor.removeMark(editor, format);
    } else {
        Editor.addMark(editor, format, true);
    }
};

const isBlockActive = (editor: CustomEditor, format: CustomElementType) => {
    const {selection} = editor;
    if (!selection) return false;

    const [match] = Array.from(
        Editor.nodes(editor, {
            at: Editor.unhangRange(editor, selection),
            match: n =>
                !Editor.isEditor(n) &&
                SlateElement.isElement(n) &&
                (n as CustomElement).type === format,
        })
    );

    return !!match;
};

const toggleBlock = (editor: CustomEditor, format: CustomElementType) => {
    const isActive = isBlockActive(editor, format);
    const isList = ['numbered-list', 'bulleted-list'].includes(format);
    const isCheckList = format === 'check-list';

    Transforms.unwrapNodes(editor, {
        match: n =>
            !Editor.isEditor(n) &&
            SlateElement.isElement(n) &&
            ['bulleted-list', 'numbered-list'].includes((n as CustomElement).type),
        split: true,
    });

    let newProperties: Partial<CustomElement>;

    if (isCheckList) {
        newProperties = {
            type: isActive ? 'paragraph' : 'check-list',
            checked: false
        };
    } else {
        newProperties = {
            type: isActive ? 'paragraph' : isList ? 'list-item' : format,
        };
    }

    Transforms.setNodes(editor, newProperties);

    if (!isActive && isList) {
        const block = {type: format, children: []};
        Transforms.wrapNodes(editor, block);
    }
};

const isAlignmentActive = (editor: CustomEditor, alignment: TextAlignment) => {
    const {selection} = editor;
    if (!selection) return false;

    const [match] = Array.from(
        Editor.nodes(editor, {
            at: Editor.unhangRange(editor, selection),
            match: n =>
                !Editor.isEditor(n) &&
                SlateElement.isElement(n) &&
                (n as CustomElement).align === alignment,
        })
    );

    return !!match;
};

const toggleAlignment = (editor: CustomEditor, alignment: TextAlignment) => {
    const isActive = isAlignmentActive(editor, alignment);

    Transforms.setNodes(
        editor,
        {align: isActive ? undefined : alignment},
        {match: n => SlateElement.isElement(n) && !Editor.isEditor(n)}
    );
};

interface MarkButtonProps {
    format: keyof Omit<CustomText, 'text'>;
    icon: LucideIcon;
    tooltipText: string;
}

const MarkButton = ({format, icon, tooltipText}: MarkButtonProps) => {
    const editor = useSlate() as CustomEditor;

    return (
        <TooltipButton
            icon={icon}
            tooltipText={tooltipText}
            variant={isMarkActive(editor, format) ? "secondary" : "ghost"}
            onClick={() => toggleMark(editor, format)}
        />
    );
};

interface BlockButtonProps {
    format: CustomElementType;
    icon: LucideIcon;
    tooltipText: string;
}

interface AlignmentButtonProps {
    alignment: TextAlignment;
    icon: LucideIcon;
    tooltipText: string;
}

const BlockButton = ({format, icon, tooltipText}: BlockButtonProps) => {
    const editor = useSlate();
    const Icon = icon;

    return (
        <TooltipButton
            icon={Icon}
            tooltipText={tooltipText}
            onClick={() => toggleBlock(editor, format)}
            variant={isBlockActive(editor, format) ? "default" : "ghost"}
        />
    );
};

const AlignmentButton = ({alignment, icon, tooltipText}: AlignmentButtonProps) => {
    const editor = useSlate();
    const Icon = icon;

    return (
        <TooltipButton
            icon={Icon}
            tooltipText={tooltipText}
            onClick={() => toggleAlignment(editor, alignment)}
            variant={isAlignmentActive(editor, alignment) ? "default" : "ghost"}
        />
    );
};

export const EditorToolbar = ({path, canWrite, onAccessDialogOpen, onDeleteDialogOpen, onAddComment}: EditorToolbarProps) => {
    const editor = useSlate() as CustomEditor;
    const [linkUrl, setLinkUrl] = useState('');
    const [linkDialogOpen, setLinkDialogOpen] = useState(false);
    const [commandKey, setCommandKey] = useState('⌘');
    const [createDocOpen, setCreateDocOpen] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const {user} = useAuth();
    const {data: rootFolder} = useRootFolder(user?.id || '');
    const navigate = useNavigate();
    const isMobile = useIsMobile();

    useEffect(() => {
        setCommandKey(window.navigator.platform.includes('Mac') ? '⌘' : 'Ctrl');
    }, []);

    const ToolbarSeparator = () => (<div className="h-6 w-[1px] bg-border mx-1"></div>);

    const handleLinkOperation = () => {
        const selection = editor.selection;
        if (!selection) return;

        const [link] = Editor.nodes(editor, {
            match: n => 'link' in (n as any),
            universal: true,
        });

        if (link) {
            Transforms.select(editor, selection);
            Editor.removeMark(editor, 'link');
        } else {
            setLinkDialogOpen(true);
        }
    };

    const applyLink = () => {
        if (!linkUrl) return;

        const selection = editor.selection;
        if (selection) {
            Editor.addMark(editor, 'link', linkUrl);
        }

        setLinkUrl('');
        setLinkDialogOpen(false);
    };

    const clearFormatting = () => {
        Editor.removeMark(editor, 'bold');
        Editor.removeMark(editor, 'italic');
        Editor.removeMark(editor, 'underline');
        Editor.removeMark(editor, 'strikethrough');
        Editor.removeMark(editor, 'link');

        Transforms.setNodes<CustomElement>(
            editor,
            {type: 'paragraph'},
            {match: n => SlateElement.isElement(n) && !Editor.isEditor(n)}
        );
    };

    return (
        <div className="bg-white h-12 flex items-center justify-between px-4 border-b no-print">
            <div className="flex items-center gap-1">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" title="File">
                            File
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        <DropdownMenuItem onClick={() => {
                            rootFolder && setCreateDocOpen(true);
                        }}>
                            <FileText className="w-4 h-4 mr-2"/> New document
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => navigate({to: `/`})}>
                            <Folder className="w-4 h-4 mr-2"/> Open
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => path && setRenameDialogOpen(true)}>
                            <Pencil className="w-4 h-4 mr-2"/> Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem onClick={onAccessDialogOpen}><UserRoundPlus className="w-4 h-4 mr-2"/> Edit
                            access</DropdownMenuItem>
                        <DropdownMenuItem onClick={printDocument}><Printer
                            className="w-4 h-4 mr-2"/> Print</DropdownMenuItem>
                        {canWrite && (
                            <>
                                <DropdownMenuSeparator/>
                                <DropdownMenuItem onClick={() => path && onDeleteDialogOpen(true)}>
                                    <Trash2 className="w-4 h-4 mr-2"/> Delete
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
                {isMobile && <>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" title="Edit">
                                Edit
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuItem onClick={() => editor.undo()}
                                              disabled={editor.history.undos.length === 0}>
                                <Undo className="w-4 h-4 mr-2"/>
                                Undo
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => editor.redo()}
                                              disabled={editor.history.redos.length === 0}>
                                <Redo className="w-4 h-4 mr-2"/>
                                Redo
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" title="Format">
                                Format
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            {/* Text formatting submenu */}
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <Type className="w-4 h-4 mr-2"/>
                                    Text
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuItem onClick={() => toggleMark(editor, 'bold')}>
                                        <Bold className="w-4 h-4 mr-2"/>
                                        Bold
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => toggleMark(editor, 'italic')}>
                                        <Italic className="w-4 h-4 mr-2"/>
                                        Italic
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => toggleMark(editor, 'underline')}>
                                        <Underline className="w-4 h-4 mr-2"/>
                                        Underline
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => toggleMark(editor, 'strikethrough')}>
                                        <Strikethrough className="w-4 h-4 mr-2"/>
                                        Strikethrough
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>

                            <DropdownMenuSeparator/>

                            {/* Heading submenu */}
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <Heading2 className="w-4 h-4 mr-2"/>
                                    Heading
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuItem onClick={() => toggleBlock(editor, 'paragraph')}>
                                        <Type className="mr-2 h-4 w-4"/> Normal text
                                    </DropdownMenuItem>
                                    <Separator className="my-1"/>
                                    <DropdownMenuItem onClick={() => toggleBlock(editor, 'heading-one')}>
                                        <Heading1 className="mr-2 h-4 w-4"/> Heading 1
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => toggleBlock(editor, 'heading-two')}>
                                        <Heading2 className="mr-2 h-4 w-4"/> Heading 2
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => toggleBlock(editor, 'heading-three')}>
                                        <Heading3 className="mr-2 h-4 w-4"/> Heading 3
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>

                            <DropdownMenuSeparator/>

                            {/* Lists submenu */}
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <List className="w-4 h-4 mr-2"/>
                                    Lists
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuItem onClick={() => toggleBlock(editor, 'numbered-list')}>
                                        <ListOrdered className="w-4 h-4 mr-2"/>
                                        Numbered List
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => toggleBlock(editor, 'bulleted-list')}>
                                        <List className="w-4 h-4 mr-2"/>
                                        Bulleted List
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => toggleBlock(editor, 'check-list')}>
                                        <CheckSquare className="w-4 h-4 mr-2"/>
                                        Check List
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>

                            <DropdownMenuSeparator/>

                            {/* Alignment submenu */}
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <AlignLeft className="w-4 h-4 mr-2"/>
                                    Align
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuItem onClick={() => toggleAlignment(editor, 'left')}>
                                        <AlignLeft className="w-4 h-4 mr-2"/>
                                        Align Left
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => toggleAlignment(editor, 'center')}>
                                        <AlignCenter className="w-4 h-4 mr-2"/>
                                        Align Center
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => toggleAlignment(editor, 'right')}>
                                        <AlignRight className="w-4 h-4 mr-2"/>
                                        Align Right
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>

                            <DropdownMenuSeparator/>

                            {/* Link */}
                            <DropdownMenuItem onClick={handleLinkOperation}>
                                <Link className="w-4 h-4 mr-2"/>
                                Add Link
                            </DropdownMenuItem>

                            <DropdownMenuSeparator/>

                            {/* Clear formatting */}
                            <DropdownMenuItem onClick={clearFormatting}>
                                <RemoveFormatting className="w-4 h-4 mr-2"/>
                                Clear Formatting
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </>}
                {canWrite && !isMobile && (
                    <>
                        <ToolbarSeparator/>

                        <TooltipButton
                            icon={Undo}
                            tooltipText={`Undo (${commandKey}+Z)`}
                            disabled={editor.history.undos.length === 0}
                            onClick={() => HistoryEditor.undo(editor)}
                        />

                        <TooltipButton
                            icon={Redo}
                            tooltipText={`Redo (${commandKey}+Y)`}
                            disabled={editor.history.redos.length === 0}
                            onClick={() => HistoryEditor.redo(editor)}
                        />
                    </>
                )}
            </div>
            <div className="flex items-center gap-1">
                {canWrite && !isMobile && (
                    <>
                        <MarkButton format="bold" icon={Bold} tooltipText={`Bold (${commandKey}+B)`}/>
                        <MarkButton format="italic" icon={Italic} tooltipText={`Italic (${commandKey}+I)`}/>
                        <MarkButton format="underline" icon={Underline} tooltipText={`Underline (${commandKey}+U)`}/>
                        <MarkButton format="strikethrough" icon={Strikethrough} tooltipText="Strikethrough"/>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" title="Headings">
                                    Heading
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => toggleBlock(editor, 'paragraph')}>
                                    <Type className="mr-2 h-4 w-4"/> Normal text
                                </DropdownMenuItem>
                                <Separator className="my-1"/>
                                <DropdownMenuItem onClick={() => toggleBlock(editor, 'heading-one')}>
                                    <Heading1 className="mr-2 h-4 w-4"/> Heading 1
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => toggleBlock(editor, 'heading-two')}>
                                    <Heading2 className="mr-2 h-4 w-4"/> Heading 2
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => toggleBlock(editor, 'heading-three')}>
                                    <Heading3 className="mr-2 h-4 w-4"/> Heading 3
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <ToolbarSeparator/>

                        <AlignmentButton alignment="left" icon={AlignLeft} tooltipText="Align Left"/>
                        <AlignmentButton alignment="center" icon={AlignCenter} tooltipText="Align Center"/>
                        <AlignmentButton alignment="right" icon={AlignRight} tooltipText="Align Right"/>

                        <ToolbarSeparator/>

                        <BlockButton format="bulleted-list" icon={List} tooltipText="Bulleted List"/>
                        <BlockButton format="numbered-list" icon={ListOrdered} tooltipText="Numbered List"/>
                        <BlockButton format="check-list" icon={CheckSquare} tooltipText="Check List"/>

                        <ToolbarSeparator/>

                        <TooltipButton
                            icon={Link}
                            tooltipText="Add link"
                            className="link-button"
                            onClick={handleLinkOperation}
                        />

                        <TooltipButton
                            icon={Link2Off}
                            tooltipText="Remove link"
                            onClick={() => Editor.removeMark(editor, 'link')}
                        />

                        <ToolbarSeparator/>

                        <TooltipButton
                            icon={RemoveFormatting}
                            tooltipText="Clear formatting"
                            onClick={clearFormatting}
                        />
                    </>
                )}
            </div>

            <div className="flex items-center gap-1">
                {onAddComment && (
                    <TooltipButton
                        icon={MessageSquare}
                        tooltipText="Add comment"
                        onClick={onAddComment}
                    />
                )}
                {canWrite ? (
                    <TooltipButton
                        icon={UserRoundPlus}
                        tooltipText="Share"
                        onClick={() => onAccessDialogOpen()}
                    />
                ) : (
                    <DocumentModeButton canWrite={canWrite}/>
                )}
            </div>

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
                        <Button type="button" variant="secondary"
                                onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={applyLink}>Save</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
};

interface EditorToolbarProps {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onDeleteDialogOpen: (open: boolean) => void;
    path: DrivePath;
    onAddComment?: () => void;
}

export default EditorToolbar;
