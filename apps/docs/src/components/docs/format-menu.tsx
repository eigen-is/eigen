import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { EIGEN_FONTS, getFontFamily } from '@workspace/lib/constants/fonts';
import type { BandEdge } from '@workspace/lib/docs/eigendoc';
import { TEXT_ALIGNS, type TextAlign } from '@workspace/lib/vector';
import { ToolbarMenu } from '@workspace/ui';
import { MenuSections } from '@workspace/ui/components/context-menu';
import {
    ChoiceMenuItems,
    ChoiceMenuSub,
    DropdownMenuItem,
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
import { tableMenuSections } from './table-menu-sections';

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
    // None while a band is edited: the body's undo holds the Normal, so a band's ⌘Z could not take it back.
    onUpdateNormalStyle?: () => void;
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
                <Type className="h-4 w-4" /> Text
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleBold().run()}>
                    <Bold className="h-4 w-4" /> Bold
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleItalic().run()}>
                    <Italic className="h-4 w-4" /> Italic
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleUnderline().run()}>
                    <Underline className="h-4 w-4" /> Underline
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleStrike().run()}>
                    <Strikethrough className="h-4 w-4" /> Strikethrough
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleSuperscript().run()}>
                    <Superscript className="h-4 w-4" /> Superscript
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleSubscript().run()}>
                    <Subscript className="h-4 w-4" /> Subscript
                </DropdownMenuItem>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <ALargeSmall className="h-4 w-4" /> Size
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem onClick={() => editor.chain().focus().stepFontSize(1).run()}>
                            <AArrowUp className="h-4 w-4" /> Increase font size
                            <DropdownMenuShortcut>{formatForDisplay('Mod+Shift+.')}</DropdownMenuShortcut>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => editor.chain().focus().stepFontSize(-1).run()}>
                            <AArrowDown className="h-4 w-4" /> Decrease font size
                            <DropdownMenuShortcut>{formatForDisplay('Mod+Shift+,')}</DropdownMenuShortcut>
                        </DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleCode().run()}>
                    <Code className="h-4 w-4" /> Inline code
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleCaps('small').run()}>
                    <CaseSensitive className="h-4 w-4" /> Small caps
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleCaps('all').run()}>
                    <CaseUpper className="h-4 w-4" /> All caps
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
                <TypeOutline className="h-4 w-4" /> Font
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
                <Heading2 className="h-4 w-4" /> Paragraph styles
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                {/* Google's own submenu: the doc's Normal is the one style it holds. */}
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Pilcrow className="h-4 w-4" /> Normal text
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                            Apply 'Normal text'
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={!onUpdateNormalStyle || !active.inParagraph}
                            onClick={onUpdateNormalStyle}
                        >
                            Update 'Normal text' to match
                        </DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                {paragraphStylesIn(editor.schema).map(({ name, type, attrs, icon: Icon }) => (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => editor.chain().focus().toggleNode(type, 'paragraph', attrs).run()}
                    >
                        <Icon className="h-4 w-4" /> {name}
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleBlockquote().run()}>
                    <Quote className="h-4 w-4" /> Quote
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <AlignLeft className="h-4 w-4" /> Align and indent
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                {TEXT_ALIGNS.map((alignment) => {
                    const { label, icon: Icon } = ALIGNMENT_LOOK[alignment];
                    return (
                        <DropdownMenuItem
                            key={alignment}
                            onClick={() => editor.chain().focus().setTextAlign(alignment).run()}
                        >
                            <Icon className="h-4 w-4" /> {label}
                        </DropdownMenuItem>
                    );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => editor.chain().focus().stepIndent(1).run()}>
                    <ListIndentIncrease className="h-4 w-4" /> Increase indent
                    <DropdownMenuShortcut>{formatForDisplay('Mod+]')}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().stepIndent(-1).run()}>
                    <ListIndentDecrease className="h-4 w-4" /> Decrease indent
                    <DropdownMenuShortcut>{formatForDisplay('Mod+[')}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onIndentationOptions}>
                    <Ruler className="h-4 w-4" /> Indentation options…
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <UnfoldVertical className="h-4 w-4" /> Line & paragraph spacing
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <ChoiceMenuItems<number>
                    value={active.lineSpacing}
                    options={LINE_SPACINGS}
                    onChange={(lineSpacing) => editor.chain().focus().setParagraphFormat({ lineSpacing }).run()}
                />
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
                    <BetweenHorizontalStart className="h-4 w-4" /> {active.spaceBefore ? 'Remove' : 'Add'} space before
                    paragraph
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
                    <BetweenHorizontalEnd className="h-4 w-4" /> {active.spaceAfter ? 'Remove' : 'Add'} space after
                    paragraph
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onCustomSpacing}>
                    <Settings2 className="h-4 w-4" /> Custom spacing…
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <List className="h-4 w-4" /> Bullets and numbering
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={!active.orderedListType}>
                        <Settings2 className="h-4 w-4" /> List options
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem onClick={onRestartNumbering}>
                            <ListRestart className="h-4 w-4" /> Restart numbering
                        </DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <ChoiceMenuSub<string>
                    trigger={
                        <>
                            <ListOrdered className="h-4 w-4" /> Numbered list
                        </>
                    }
                    value={active.orderedListType}
                    options={NUMBERED_LIST_STYLES.map(({ type, preview }) => ({ value: type, label: preview }))}
                    onChange={(type) => setNumberedListType(editor, type)}
                />
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleBulletList().run()}>
                    <List className="h-4 w-4" /> Bulleted list
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleTaskList().run()}>
                    <CheckSquare className="h-4 w-4" /> Checklist
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {onEnterBand && onPageNumbers && (
            <>
                <DropdownMenuItem onClick={() => onEnterBand('header')}>
                    <PanelTop className="h-4 w-4" /> Headers and footers
                </DropdownMenuItem>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Hash className="h-4 w-4" /> Page numbers
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <PageNumberItems editor={editor} onPreset={onPageNumbers} />
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </>
        )}
        <DropdownMenuItem onClick={onPageSetup}>
            <RotateCwSquare className="h-4 w-4" /> Page orientation
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!active.table}>
                <Table className="h-4 w-4" /> Table
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <MenuSections {...tableMenuSections(editor, active)} />
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!active.figure}>
                <ImageIcon className="h-4 w-4" /> Image
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuItem onClick={onReplaceImage}>
                    <ImagePlus className="h-4 w-4" /> Replace image
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={clearFormatting}>
            <RemoveFormatting className="h-4 w-4" /> Clear formatting
            <DropdownMenuShortcut>{formatForDisplay('Mod+\\')}</DropdownMenuShortcut>
        </DropdownMenuItem>
    </ToolbarMenu>
);
