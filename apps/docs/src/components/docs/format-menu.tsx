import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { EIGEN_FONTS, getFontFamily } from '@workspace/lib/constants/fonts';
import type { BandEdge } from '@workspace/lib/docs/eigendoc';
import { TEXT_ALIGNS, type TextAlign } from '@workspace/lib/vector';
import { ToolbarMenu } from '@workspace/ui';
import {
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ColorPickerMenuItem } from '@workspace/ui/components/media';
import {
    AArrowDown,
    AArrowUp,
    ALargeSmall,
    AlignCenter,
    AlignJustify,
    AlignLeft,
    AlignRight,
    Baseline,
    BetweenHorizontalEnd,
    BetweenHorizontalStart,
    Bold,
    CaseSensitive,
    CaseUpper,
    CheckSquare,
    Code,
    Hash,
    Heading2,
    Highlighter,
    ImageIcon,
    ImagePlus,
    Italic,
    List,
    ListIndentDecrease,
    ListIndentIncrease,
    ListOrdered,
    ListRestart,
    type LucideIcon,
    PanelTop,
    Pilcrow,
    Quote,
    RemoveFormatting,
    RotateCwSquare,
    Ruler,
    Settings2,
    Strikethrough,
    Subscript,
    Superscript,
    Table,
    Type,
    TypeOutline,
    Underline,
    UnfoldVertical,
} from 'lucide-react';
import type { ToolbarState } from './hooks/use-toolbar-state';
import { setNumberedListType } from './list-numbering';
import { PageNumberItems, type PageNumberPreset } from './page-numbers';
import { paragraphStylesIn } from './paragraph-styles';
import { TABLE_ACTION_ICONS } from './table-action-icons';

// Format › Align and indent and the icon row's Align dropdown name each alignment alike.
export const ALIGNMENT_LOOK: Record<TextAlign, { label: string; icon: LucideIcon }> = {
    left: { label: 'Left', icon: AlignLeft },
    center: { label: 'Center', icon: AlignCenter },
    right: { label: 'Right', icon: AlignRight },
    justify: { label: 'Justified', icon: AlignJustify },
};

// Format › Bullets and numbering › Numbered list: Google's single-level styles, by the type a list stores.
const NUMBERED_LIST_STYLES = [
    { type: '1', preview: '1. 2. 3.' },
    { type: 'a', preview: 'a. b. c.' },
    { type: 'A', preview: 'A. B. C.' },
    { type: 'i', preview: 'i. ii. iii.' },
    { type: 'I', preview: 'I. II. III.' },
] as const;

// Format › Line & paragraph spacing: Google's presets, by the multiple a paragraph stores.
const LINE_SPACINGS = [
    { value: 1, label: 'Single' },
    { value: 1.15, label: '1.15' },
    { value: 1.5, label: '1.5' },
    { value: 2, label: 'Double' },
] as const;

// What Add space before or after paragraph sets, in pt: Word's amount, as Google's is unchecked.
const ADDED_SPACE = 12;

type FormatMenuProps = {
    editor: Editor;
    active: ToolbarState;
    keepEditorFocus: (e: Event) => void;
    setTextColor: (color: string) => void;
    setHighlightColor: (color: string) => void;
    clearFormatting: () => void;
    onRestartNumbering: () => void;
    onCustomSpacing: () => void;
    onUpdateNormalStyle: () => void;
    onIndentationOptions: () => void;
    onPageSetup: () => void;
    onReplaceImage: () => void;
    onEnterBand?: (edge: BandEdge) => void;
    onPageNumbers?: (preset: PageNumberPreset) => void;
};

export const FormatMenu = ({
    editor,
    active,
    keepEditorFocus,
    setTextColor,
    setHighlightColor,
    clearFormatting,
    onRestartNumbering,
    onCustomSpacing,
    onUpdateNormalStyle,
    onIndentationOptions,
    onPageSetup,
    onReplaceImage,
    onEnterBand,
    onPageNumbers,
}: FormatMenuProps) => (
    <ToolbarMenu label="Format" onCloseAutoFocus={keepEditorFocus}>
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
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleUnderline().run()}>
                    <Underline className="h-4 w-4 mr-2" /> Underline
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleStrike().run()}>
                    <Strikethrough className="h-4 w-4 mr-2" /> Strikethrough
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleSuperscript().run()}>
                    <Superscript className="h-4 w-4 mr-2" /> Superscript
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleSubscript().run()}>
                    <Subscript className="h-4 w-4 mr-2" /> Subscript
                </DropdownMenuItem>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <ALargeSmall className="h-4 w-4 mr-2" /> Size
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem onClick={() => editor.chain().focus().stepFontSize(1).run()}>
                            <AArrowUp className="h-4 w-4 mr-2" /> Increase font size
                            <DropdownMenuShortcut>{formatForDisplay('Mod+Shift+.')}</DropdownMenuShortcut>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => editor.chain().focus().stepFontSize(-1).run()}>
                            <AArrowDown className="h-4 w-4 mr-2" /> Decrease font size
                            <DropdownMenuShortcut>{formatForDisplay('Mod+Shift+,')}</DropdownMenuShortcut>
                        </DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleCode().run()}>
                    <Code className="h-4 w-4 mr-2" /> Inline code
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleCaps('small').run()}>
                    <CaseSensitive className="h-4 w-4 mr-2" /> Small caps
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleCaps('all').run()}>
                    <CaseUpper className="h-4 w-4 mr-2" /> All caps
                    <DropdownMenuShortcut>{formatForDisplay('Mod+Shift+A')}</DropdownMenuShortcut>
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
                        onClick={() => editor.chain().focus().setFontFamily(font.name).run()}
                    >
                        <span style={{ fontFamily: getFontFamily(font.name) }}>{font.name}</span>
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
                {/* Google's own submenu: the doc's Normal is the one style it holds. */}
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Pilcrow className="mr-2 h-4 w-4" /> Normal text
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                            Apply 'Normal text'
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onUpdateNormalStyle}>Update 'Normal text' to match</DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                {paragraphStylesIn(editor.schema).map(({ name, type, attrs, icon: Icon }) => (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => editor.chain().focus().toggleNode(type, 'paragraph', attrs).run()}
                    >
                        <Icon className="mr-2 h-4 w-4" /> {name}
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleBlockquote().run()}>
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
                            onClick={() => editor.chain().focus().setTextAlign(alignment).run()}
                        >
                            <Icon className="h-4 w-4 mr-2" /> {label}
                        </DropdownMenuItem>
                    );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => editor.chain().focus().stepIndent(1).run()}>
                    <ListIndentIncrease className="h-4 w-4 mr-2" /> Increase indent
                    <DropdownMenuShortcut>{formatForDisplay('Mod+]')}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().stepIndent(-1).run()}>
                    <ListIndentDecrease className="h-4 w-4 mr-2" /> Decrease indent
                    <DropdownMenuShortcut>{formatForDisplay('Mod+[')}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onIndentationOptions}>
                    <Ruler className="h-4 w-4 mr-2" /> Indentation options…
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <UnfoldVertical className="h-4 w-4 mr-2" /> Line & paragraph spacing
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={active.lineSpacing === undefined ? '' : String(active.lineSpacing)}>
                    {LINE_SPACINGS.map(({ value, label }) => (
                        <DropdownMenuRadioItem
                            key={label}
                            value={String(value)}
                            onSelect={() => editor.chain().focus().setParagraphFormat({ lineSpacing: value }).run()}
                        >
                            {label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    disabled={!active.paragraphSpacing}
                    onClick={() =>
                        editor
                            .chain()
                            .focus()
                            .setParagraphFormat({ spaceBefore: active.spaceBefore ? 0 : ADDED_SPACE })
                            .run()
                    }
                >
                    <BetweenHorizontalStart className="h-4 w-4 mr-2" /> {active.spaceBefore ? 'Remove' : 'Add'} space
                    before paragraph
                </DropdownMenuItem>
                <DropdownMenuItem
                    disabled={!active.paragraphSpacing}
                    onClick={() =>
                        editor
                            .chain()
                            .focus()
                            .setParagraphFormat({ spaceAfter: active.spaceAfter ? 0 : ADDED_SPACE })
                            .run()
                    }
                >
                    <BetweenHorizontalEnd className="h-4 w-4 mr-2" /> {active.spaceAfter ? 'Remove' : 'Add'} space after
                    paragraph
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onCustomSpacing}>
                    <Settings2 className="h-4 w-4 mr-2" /> Custom spacing…
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <List className="h-4 w-4 mr-2" /> Bullets and numbering
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={!active.orderedListType}>
                        <Settings2 className="h-4 w-4 mr-2" /> List options
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem onClick={onRestartNumbering}>
                            <ListRestart className="h-4 w-4 mr-2" /> Restart numbering
                        </DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <ListOrdered className="h-4 w-4 mr-2" /> Numbered list
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup value={active.orderedListType}>
                            {NUMBERED_LIST_STYLES.map(({ type, preview }) => (
                                <DropdownMenuRadioItem
                                    key={type}
                                    value={type}
                                    onSelect={() => setNumberedListType(editor, type)}
                                >
                                    {preview}
                                </DropdownMenuRadioItem>
                            ))}
                        </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleBulletList().run()}>
                    <List className="h-4 w-4 mr-2" /> Bulleted list
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleTaskList().run()}>
                    <CheckSquare className="h-4 w-4 mr-2" /> Checklist
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {onEnterBand && onPageNumbers && (
            <>
                <DropdownMenuItem onClick={() => onEnterBand('header')}>
                    <PanelTop className="h-4 w-4 mr-2" /> Headers and footers
                </DropdownMenuItem>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Hash className="h-4 w-4 mr-2" /> Page numbers
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <PageNumberItems editor={editor} onPreset={onPageNumbers} />
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </>
        )}
        <DropdownMenuItem onClick={onPageSetup}>
            <RotateCwSquare className="h-4 w-4 mr-2" /> Page orientation
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!active.table}>
                <Table className="h-4 w-4 mr-2" /> Table
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => editor.chain().focus().addRowBefore().run()}>
                    <TABLE_ACTION_ICONS.addRowBefore className="h-4 w-4 mr-2" /> Insert row above
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().addRowAfter().run()}>
                    <TABLE_ACTION_ICONS.addRowAfter className="h-4 w-4 mr-2" /> Insert row below
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().addColumnBefore().run()}>
                    <TABLE_ACTION_ICONS.addColumnBefore className="h-4 w-4 mr-2" /> Insert column left
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().addColumnAfter().run()}>
                    <TABLE_ACTION_ICONS.addColumnAfter className="h-4 w-4 mr-2" /> Insert column right
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => editor.chain().focus().deleteRow().run()}>
                    <TABLE_ACTION_ICONS.deleteRow className="h-4 w-4 mr-2" /> Delete row
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().deleteColumn().run()}>
                    <TABLE_ACTION_ICONS.deleteColumn className="h-4 w-4 mr-2" /> Delete column
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().deleteTable().run()}>
                    <TABLE_ACTION_ICONS.deleteTable className="h-4 w-4 mr-2" /> Delete table
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => editor.chain().focus().distributeColumns().run()}>
                    <TABLE_ACTION_ICONS.distributeColumns className="h-4 w-4 mr-2" /> Distribute columns
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
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeaderRow().run()}>
                    <TABLE_ACTION_ICONS.toggleHeaderRow className="h-4 w-4 mr-2" /> Toggle header row
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
);
