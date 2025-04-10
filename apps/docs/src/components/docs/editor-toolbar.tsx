import { Editor, Element as SlateElement, Transforms, BaseEditor } from "slate";
import { useSlate, ReactEditor } from "slate-react";
import { HistoryEditor } from "slate-history";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  TextQuote,
  List,
  ListOrdered,
  RemoveFormatting,
  Printer,
  MoreVertical,
  SpellCheck,
  Heading1,
  Heading2,
  Heading3,
  Undo,
  Redo,
  LucideIcon,
  FileText,
  Files,
  Folder,
  Trash2,
  CheckSquare,
  Type
} from "lucide-react";
import { TooltipButton } from "@workspace/ui";
import { Button } from "@workspace/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Separator } from "@workspace/ui/components/separator";

// Define the types for custom elements and text
type CustomElementType = 
  | 'paragraph' 
  | 'heading-one' 
  | 'heading-two' 
  | 'heading-three'
  | 'block-quote'
  | 'bulleted-list'
  | 'numbered-list'
  | 'list-item'
  | 'check-list-item';

interface CustomElement {
  type: CustomElementType;
  children: CustomText[];
  checked?: boolean;
}

interface CustomText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

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
  const { selection } = editor;
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
  const isCheckList = format === 'check-list-item';

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
      type: isActive ? 'paragraph' : 'check-list-item',
      checked: false
    };
  } else {
    newProperties = {
      type: isActive ? 'paragraph' : isList ? 'list-item' : format,
    };
  }

  Transforms.setNodes(editor, newProperties);

  if (!isActive && isList) {
    const block = { type: format, children: [] };
    Transforms.wrapNodes(editor, block);
  }
};

// Mark Button Component
interface MarkButtonProps {
  format: keyof Omit<CustomText, 'text'>;
  icon: LucideIcon;
  tooltipText: string;
}

const MarkButton = ({ format, icon, tooltipText }: MarkButtonProps) => {
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

const BlockButton = ({ format, icon, tooltipText }: BlockButtonProps) => {
  const editor = useSlate() as CustomEditor;
  
  return (
    <TooltipButton
      icon={icon}
      tooltipText={tooltipText}
      variant={isBlockActive(editor, format) ? "secondary" : "ghost"}
      onClick={() => toggleBlock(editor, format)}
    />
  );
};

export const EditorToolbar = () => {
  const editor = useSlate() as CustomEditor;
  const commandKey = window.navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  
  return (
    <div className="bg-white h-12 flex items-center justify-between px-4 border-b mb-0 no-print">
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" title="File">
              File
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem><FileText /> New document</DropdownMenuItem>
            <DropdownMenuItem><Folder /> Open</DropdownMenuItem>
            <DropdownMenuItem><Files /> Make a copy</DropdownMenuItem>
            <Separator />
            <DropdownMenuItem onClick={() => window.print()}><Printer /> Print</DropdownMenuItem>
            <Separator />
            <DropdownMenuItem><Trash2 /> Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Separator */}
        <div className="h-6 w-[1px] bg-border mx-1"></div>

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

      </div>
      <div className="flex items-center gap-1">

        <MarkButton format="bold" icon={Bold} tooltipText={`Bold (${commandKey}+B)`} />
        <MarkButton format="italic" icon={Italic} tooltipText={`Italic (${commandKey}+I)`} />
        <MarkButton format="underline" icon={Underline} tooltipText={`Underline (${commandKey}+U)`} />
        <MarkButton format="strikethrough" icon={Strikethrough} tooltipText="Strikethrough" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" title="Headings">
              Heading
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => toggleBlock(editor, 'paragraph')}>
              <Type className="mr-2 h-4 w-4" /> Normal text
            </DropdownMenuItem>
            <Separator className="my-1" />
            <DropdownMenuItem onClick={() => toggleBlock(editor, 'heading-one')}>
              <Heading1 className="mr-2 h-4 w-4" /> Heading 1
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => toggleBlock(editor, 'heading-two')}>
              <Heading2 className="mr-2 h-4 w-4" /> Heading 2
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => toggleBlock(editor, 'heading-three')}>
              <Heading3 className="mr-2 h-4 w-4" /> Heading 3
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Separator */}
        <div className="h-6 w-[1px] bg-border mx-1"></div>

        <BlockButton format="block-quote" icon={TextQuote} tooltipText="Blockquote" />
        <BlockButton format="bulleted-list" icon={List} tooltipText="Bulleted List" />
        <BlockButton format="numbered-list" icon={ListOrdered} tooltipText="Numbered List" />
        <BlockButton format="check-list-item" icon={CheckSquare} tooltipText="Check List" />

        {/* Separator */}
        <div className="h-6 w-[1px] bg-border mx-1"></div>

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
            
            // Convert to paragraph
            Transforms.setNodes<CustomElement>(
              editor,
              { type: 'paragraph' },
              { match: n => SlateElement.isElement(n) && !Editor.isEditor(n) }
            );
          }}
        />
      </div>

      <div className="flex items-center gap-1">
        {/* Right side icons */}
        <TooltipButton
          icon={Printer}
          tooltipText="Print"
          onClick={() => window.print()}
        />

        <div className="h-6 w-[1px] bg-border mx-1"></div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" title="More actions">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem>
              <SpellCheck className="h-4 w-4 mr-2" /> Spell check
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.print()}>
              <Printer className="h-4 w-4 mr-2" /> Print
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
