// The Docs Format menu: text, paragraph styles, alignment and spacing, lists, headers and page numbers, the switch
// between pages and page-less, and the table, image and text box submenus that a phone, which has no properties panel,
// reaches those options through. Every item acts on the editor the toolbar follows: the body's, a band's being edited
// or the open story's. The icon row's Align dropdown draws its options from here too.

import type { Hotkey } from '@tanstack/react-hotkeys';
import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { readHexColor } from '@workspace/lib/constants/colors';
import { EIGEN_FONTS, getFontFamily } from '@workspace/lib/constants/fonts';
import type { BandEdge, FigureLayout } from '@workspace/lib/docs/eigendoc';
import type { TextAlign } from '@workspace/lib/vector';
import { TEXT_ALIGNS } from '@workspace/lib/vector';
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
import { AppBarMenu } from '@workspace/ui/components/layout/toolbar';
import { ColorPickerMenuItem } from '@workspace/ui/components/media';
import type { LucideIcon } from 'lucide-react';
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
    PaintBucket,
    PanelTop,
    Pilcrow,
    Quote,
    RemoveFormatting,
    RotateCwSquare,
    Ruler,
    ScrollText,
    Settings2,
    SquareDashed,
    Strikethrough,
    Subscript,
    Superscript,
    Table,
    Type,
    TypeOutline,
    Underline,
    UnfoldVertical,
} from 'lucide-react';
import { setImageLayout } from './extensions/figure-frame';
import { inBand, selectionDrawsInLine } from './extensions/positioned-figure';
import { setTextBoxLayout } from './extensions/text-box';
import { figureLayoutLooks } from './figure-properties-panel';
import type { ToolbarState } from './hooks/use-toolbar-state';
import { setNumberedListType } from './list-numbering';
import type { PageNumberPreset } from './page-numbers';
import { PageNumberItems } from './page-numbers';
import { paragraphStylesIn } from './paragraph-styles';
import { tableMenuSections } from './table-menu-sections';

// The keys the editor binds for commands that Format and the icon row both offer, so the menu's rows and the row's
// tooltips name the same ones.
export const FORMAT_HOTKEYS = {
    bold: 'Mod+B',
    italic: 'Mod+I',
    underline: 'Mod+U',
    clearFormatting: 'Mod+\\',
} as const satisfies Record<string, Hotkey>;

// How a menu row draws an option: its icon, then its name.
type MenuLook = { label: string; icon: LucideIcon };

// Format › Align and indent and the icon row's Align dropdown name each alignment alike.
export const ALIGNMENT_LOOK: Record<TextAlign, MenuLook> = {
    left: { label: 'Left', icon: AlignLeft },
    center: { label: 'Center', icon: AlignCenter },
    right: { label: 'Right', icon: AlignRight },
    justify: { label: 'Justified', icon: AlignJustify },
};

// One option of a choice, drawn in its look, such as an alignment in the Align dropdown or a layout in Format › Image.
export function lookOption<T>(value: T, { label, icon: Icon }: MenuLook) {
    return {
        value,
        label: (
            <>
                <Icon className="h-4 w-4" /> {label}
            </>
        ),
    };
}

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

// What Add space before or after paragraph sets, in pt. It is Word's amount, as Google's has not been checked.
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
    // A page-less doc has no paper on screen, so Page orientation leaves the menu, as in Google.
    pageless: boolean;
    onSwitchFormat: () => void;
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
    pageless,
    onSwitchFormat,
}: FormatMenuProps) => (
    <AppBarMenu label="Format" onCloseAutoFocus={keepEditorFocus}>
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <Type className="h-4 w-4" /> Text
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleBold().run()}>
                    <Bold className="h-4 w-4" /> Bold
                    <DropdownMenuShortcut>{formatForDisplay(FORMAT_HOTKEYS.bold)}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleItalic().run()}>
                    <Italic className="h-4 w-4" /> Italic
                    <DropdownMenuShortcut>{formatForDisplay(FORMAT_HOTKEYS.italic)}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleUnderline().run()}>
                    <Underline className="h-4 w-4" /> Underline
                    <DropdownMenuShortcut>{formatForDisplay(FORMAT_HOTKEYS.underline)}</DropdownMenuShortcut>
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
                {paragraphStylesIn(editor.schema, 'all').map(({ name, type, attrs, icon: Icon }) => (
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
                <ChoiceMenuItems
                    value={active.alignment}
                    options={TEXT_ALIGNS.map((alignment) => lookOption(alignment, ALIGNMENT_LOOK[alignment]))}
                    onChange={(alignment) => editor.chain().focus().setTextAlign(alignment).run()}
                />
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
        {!pageless && (
            <DropdownMenuItem onClick={onPageSetup}>
                <RotateCwSquare className="h-4 w-4" /> Page orientation
            </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onSwitchFormat}>
            <ScrollText className="h-4 w-4" /> {pageless ? 'Switch to pages format' : 'Switch to page-less format'}
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
            <DropdownMenuSubTrigger disabled={!active.figureLayout}>
                <ImageIcon className="h-4 w-4" /> Image
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuItem onClick={onReplaceImage}>
                    <ImagePlus className="h-4 w-4" /> Replace image
                </DropdownMenuItem>
                {/* The Image panel's layouts, for a phone, which has no panel. A band's panel offers none, so
                    neither does the menu. Where the image draws in line, in a note or a cell, only the layouts in the
                    flow are offered. */}
                {!inBand(editor) && (
                    <>
                        <DropdownMenuSeparator />
                        <ChoiceMenuItems<FigureLayout>
                            value={active.figureLayout}
                            options={figureLayoutLooks(selectionDrawsInLine(editor)).map((look) =>
                                lookOption(look.layout, look),
                            )}
                            onChange={(layout) => setImageLayout(editor, { layout })}
                        />
                    </>
                )}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!active.textBox}>
                <SquareDashed className="h-4 w-4" /> Text box
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                {/* The Text box panel's layouts and fill, which a phone has no panel for. */}
                <ChoiceMenuItems<FigureLayout>
                    value={active.textBox?.layout}
                    options={figureLayoutLooks(selectionDrawsInLine(editor)).map((look) =>
                        lookOption(look.layout, look),
                    )}
                    onChange={(layout) => setTextBoxLayout(editor, { layout })}
                />
                <DropdownMenuSeparator />
                <ColorPickerMenuItem
                    icon={PaintBucket}
                    label="Fill"
                    value={active.textBox?.fill ?? ''}
                    resetLabel="None"
                    onChange={(color) => editor.commands.updateTextBox({ fill: readHexColor(color) })}
                />
            </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={clearFormatting}>
            <RemoveFormatting className="h-4 w-4" /> Clear formatting
            <DropdownMenuShortcut>{formatForDisplay(FORMAT_HOTKEYS.clearFormatting)}</DropdownMenuShortcut>
        </DropdownMenuItem>
    </AppBarMenu>
);
