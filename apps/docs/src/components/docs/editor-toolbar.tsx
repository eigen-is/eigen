import {BaseEditor, Editor, Element as SlateElement, Range, Transforms} from "slate";
import {ReactEditor, useSlate} from "slate-react";
import {HistoryEditor} from "slate-history";
import {
    Bold,
    CheckSquare,
    Files,
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
    Printer,
    Redo,
    RemoveFormatting,
    Strikethrough,
    TextQuote,
    Trash2,
    Type,
    Underline,
    Undo,
    AlignLeft,
    AlignCenter,
    AlignRight,
    Pencil,
    EyeClosedIcon,
    EyeOffIcon,
    Eye,
    Share,
    UserPlus
} from "lucide-react";
import {TooltipButton} from "@workspace/ui";
import {Button} from "@workspace/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {Separator} from "@workspace/ui/components/separator";
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,} from "@workspace/ui/components/dialog";
import {Input} from "@workspace/ui/components/input";
import {Label} from "@workspace/ui/components/label";
import {printElement} from "@workspace/ui/lib/printElement";
import {useCallback, useState} from "react";
import {CustomElement, CustomElementType, CustomText, TextAlignment} from "./editor.types";
import {DocumentModeButton} from "@workspace/ui/components/layout/toolbar/DocumentModeButton";

// Define custom editor type
type CustomEditor = BaseEditor & ReactEditor & HistoryEditor;

// Declare module augmentations to extend Slate's types
declare module 'slate' {
    interface CustomTypes {
        Editor: CustomEditor;
        Element: CustomElement;
        Text: CustomText;
    }
}

// Helper functions for formatting
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

// Check if a link is active
const isLinkActive = (editor: CustomEditor) => {
    const marks = Editor.marks(editor);
    return marks ? marks.link !== undefined : false;
};

// Check if alignment is active
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

// Toggle alignment
const toggleAlignment = (editor: CustomEditor, alignment: TextAlignment) => {
    const isActive = isAlignmentActive(editor, alignment);
    
    Transforms.setNodes(
        editor,
        { align: isActive ? undefined : alignment },
        { match: n => SlateElement.isElement(n) && !Editor.isEditor(n) }
    );
};

// Get the current link URL if any
const getLinkUrl = (editor: CustomEditor) => {
    const marks = Editor.marks(editor);
    return marks && marks.link ? marks.link : '';
};

// Mark Button Component
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

// Block Button Component
interface BlockButtonProps {
    format: CustomElementType;
    icon: LucideIcon;
    tooltipText: string;
}

// Alignment Button Component
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

// Link button component
const LinkButton = () => {
    const editor = useSlate() as CustomEditor;
    const [open, setOpen] = useState(false);
    const [url, setUrl] = useState('');
    const [text, setText] = useState('');
    const [selectedText, setSelectedText] = useState('');

    const isActive = isLinkActive(editor as CustomEditor);

    const handleOpenDialog = () => {
        // Get the selected text
        const {selection} = editor;
        if (selection && !Range.isCollapsed(selection)) {
            const selectedText = Editor.string(editor, selection);
            setSelectedText(selectedText);
            setText(selectedText);
        } else {
            setSelectedText('');
            setText('');
        }

        // Get current link URL if any
        setUrl(getLinkUrl(editor as CustomEditor));
        setOpen(true);
    };

    const handleCreateLink = () => {
        const {selection} = editor;

        if (!url) {
            // If URL is empty, remove the link
            Editor.removeMark(editor, 'link');
        } else if (selection && !Range.isCollapsed(selection)) {
            // If there's a selection, apply link to it
            if (text && text !== selectedText) {
                // Replace the selected text with the new text
                Transforms.delete(editor);
                Transforms.insertText(editor, text);
            }
            Editor.addMark(editor, 'link', url);
        } else if (text) {
            // If there's no selection but text is provided, insert new linked text
            Transforms.insertText(editor, text);
            const end = editor.selection ? editor.selection.anchor.offset : 0;
            const start = end - text.length;

            if (start >= 0) {
                Transforms.select(editor, {
                    anchor: {path: editor.selection!.anchor.path, offset: start},
                    focus: {path: editor.selection!.focus.path, offset: end}
                });
                Editor.addMark(editor, 'link', url);
                // Reset selection
                Transforms.collapse(editor, {edge: 'end'});
            }
        }

        setOpen(false);
    };

    const handleRemoveLink = () => {
        Editor.removeMark(editor, 'link');
        setOpen(false);
    };

    return (
        <>
            <TooltipButton
                variant="ghost"
                size="icon"
                tooltipText="Link"
                onClick={handleOpenDialog}
                className={isActive ? 'bg-accent text-accent-foreground' : ''}
                icon={Link}
            />

            {isActive && (
                <TooltipButton
                    variant="ghost"
                    size="icon"
                    tooltipText="Remove Link"
                    onClick={handleRemoveLink}
                    icon={Link2Off}
                />
            )}

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Create link</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label htmlFor="link-text" className="text-right">
                                Text
                            </Label>
                            <Input
                                id="link-text"
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                className="col-span-3"
                            />
                        </div>
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label htmlFor="link-url" className="text-right">
                                URL
                            </Label>
                            <Input
                                id="link-url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                className="col-span-3"
                            />
                        </div>
                    </div>
                    <DialogFooter className="flex justify-between">
                        <div className="flex gap-2">
                            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                                Cancel
                            </Button>
                            <Button type="button" onClick={handleCreateLink}>
                                Save
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
};

interface EditorToolbarProps {
    canWrite: boolean;
}

export const EditorToolbar = ({ canWrite }: EditorToolbarProps) => {
    const editor = useSlate() as CustomEditor;
    const commandKey = window.navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
    const printDocument = useCallback(() => printElement(document.querySelector('[data-document]')!), []);

    const ToolbarSeparator = () => (<div className="h-6 w-[1px] bg-border mx-1"></div>);
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
                        <DropdownMenuItem><FileText/> New document</DropdownMenuItem>
                        <DropdownMenuItem><Folder/> Open</DropdownMenuItem>
                        <DropdownMenuItem><Files/> Make a copy</DropdownMenuItem>
                        <Separator/>
                        <DropdownMenuItem onClick={printDocument}><Printer/> Print</DropdownMenuItem>
                        {canWrite && (
                            <>
                                <Separator/>
                                <DropdownMenuItem><Trash2/> Delete</DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
                {canWrite && (
                    <>
                        {/* Separator */}
                        <ToolbarSeparator/>

                        <TooltipButton
                            icon={Undo}
                            tooltipText={`Undo (${commandKey}+Z)`}
                            onClick={() => HistoryEditor.undo(editor)}
                        />

                        <TooltipButton
                            icon={Redo}
                            tooltipText={`Redo (${commandKey}+Y)`}
                            onClick={() => HistoryEditor.redo(editor)}
                        />
                    </>
                )}  
            </div>
            <div className="flex items-center gap-1">
            {canWrite && (
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

                    <BlockButton format="block-quote" icon={TextQuote} tooltipText="Blockquote"/>
                    <BlockButton format="bulleted-list" icon={List} tooltipText="Bulleted List"/>
                    <BlockButton format="numbered-list" icon={ListOrdered} tooltipText="Numbered List"/>
                    <BlockButton format="check-list" icon={CheckSquare} tooltipText="Check List"/>

                    <ToolbarSeparator/>

                    <LinkButton/>

                    <ToolbarSeparator/>

                    <TooltipButton
                        icon={RemoveFormatting}
                        tooltipText="Clear formatting"
                        onClick={() => {
                            // Remove all marks
                            Editor.removeMark(editor, 'bold');
                            Editor.removeMark(editor, 'italic');
                            Editor.removeMark(editor, 'underline');
                            Editor.removeMark(editor, 'strikethrough');
                            Editor.removeMark(editor, 'code');
                            Editor.removeMark(editor, 'link');

                            // Convert to paragraph
                            Transforms.setNodes<CustomElement>(
                                editor,
                                {type: 'paragraph'},
                                {match: n => SlateElement.isElement(n) && !Editor.isEditor(n)}
                            );
                        }}
                    />
                </>
                )}
            </div>

            <div className="flex items-center gap-1">
                {canWrite ? (
                    <TooltipButton
                        icon={UserPlus}
                        tooltipText="Share"
                    />
                ) : (
                    <DocumentModeButton canWrite={canWrite} />
                )}
            </div>
        </div>
    );
};
