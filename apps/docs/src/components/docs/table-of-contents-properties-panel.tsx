// The Docs panel for the selected table of contents: its layout, how many heading levels it lists, as Word's Show
// levels does, and the font, size, bold and italic of each level's entries, for all levels at once or for one. It
// opens beside the page when the node is selected and writes through the editor that holds it, such as the body's, so
// that editor's undo takes the change back. Every write keeps the node selected, so the panel stays open.

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { nextFontSize } from '@workspace/lib/constants/fonts';
import type { TocLevelStyle, TocPreset } from '@workspace/lib/docs/eigendoc';
import {
    MAX_HEADING_LEVEL,
    readTocLevelStyle,
    readTocLevels,
    TOC_LEVEL_KEYS,
    TOC_PRESETS,
    tocPreset,
} from '@workspace/lib/docs/eigendoc';
import { FontSizeStepper } from '@workspace/ui/components/media';
import {
    FontRow,
    getMergedValue,
    isMixed,
    MergedSelect,
    numToStr,
    PropertiesPanel,
    PropertyRow,
    PropertySection,
    PropertyToggle,
} from '@workspace/ui/components/properties-panel';
import { Bold, Italic } from 'lucide-react';
import { useState } from 'react';

const LEVEL_OPTIONS: readonly { value: string; label: string }[] = Array.from(
    { length: MAX_HEADING_LEVEL },
    (_, index) => ({
        value: String(index + 1),
        label: String(index + 1),
    }),
);

// Google's three layouts, in the order its panel lists them.
const PRESET_OPTIONS: readonly { value: TocPreset; label: string }[] = [
    { value: 'plain', label: 'Plain text' },
    { value: 'dotted', label: 'Dotted' },
    { value: 'links', label: 'Links' },
];

// A page-less doc has no page numbers to show, so it draws Links whatever is stored.
const PAGELESS_PRESET_OPTIONS = PRESET_OPTIONS.filter(({ value }) => value === 'links');

const ALL_LEVELS = 'all';

const PICKED_OPTIONS: readonly { value: string; label: string }[] = [
    { value: ALL_LEVELS, label: 'All levels' },
    ...TOC_LEVEL_KEYS.map((key, index) => ({ value: key, label: `Level ${index + 1}` })),
];

export function TableOfContentsPropertiesPanel({ editor, pageless }: { editor: Editor; pageless: boolean }) {
    // The level the text rows show and set, or all of them.
    const [picked, setPicked] = useState(ALL_LEVELS);
    // useEditor re-renders on no transaction, and a write that keeps the node selected fires no selectionUpdate.
    const attrs = useEditorState({ editor, selector: ({ editor: e }) => e.getAttributes('tableOfContents') });
    // A level with no look draws as the body text, in the Normal of the editor that holds it.
    const normal = editor.storage.eigenFontSize.normalStyle();
    const looks = TOC_LEVEL_KEYS.filter((key) => picked === ALL_LEVELS || key === picked).map((key) => ({
        key,
        look: readTocLevelStyle(attrs[key]) ?? {},
    }));
    const font = getMergedValue(looks, ({ look }) => look.font ?? normal.font);
    const size = getMergedValue(looks, ({ look }) => look.size ?? normal.size);
    const bold = getMergedValue(looks, ({ look }) => look.bold ?? false);
    const italic = getMergedValue(looks, ({ look }) => look.italic ?? false);
    // The change to each picked level, from its own look, in one write.
    const restyle = (change: (look: TocLevelStyle) => TocLevelStyle) =>
        editor.commands.updateTableOfContents(Object.fromEntries(looks.map(({ key, look }) => [key, change(look)])));

    return (
        <PropertiesPanel title="Table of contents">
            <PropertySection title="Layout">
                <PropertyRow label="Format">
                    <MergedSelect
                        value={tocPreset(attrs, pageless)}
                        onChange={(preset) => editor.commands.updateTableOfContents(TOC_PRESETS[preset])}
                        options={pageless ? PAGELESS_PRESET_OPTIONS : PRESET_OPTIONS}
                    />
                </PropertyRow>
                <PropertyRow label="Levels">
                    <MergedSelect
                        value={numToStr(readTocLevels(attrs['levels']))}
                        onChange={(value) => editor.commands.updateTableOfContents({ levels: Number(value) })}
                        options={LEVEL_OPTIONS}
                    />
                </PropertyRow>
            </PropertySection>
            <PropertySection title="Text">
                <PropertyRow label="Level">
                    <MergedSelect value={picked} onChange={setPicked} options={PICKED_OPTIONS} />
                </PropertyRow>
                <FontRow value={font} onChange={(name) => restyle((look) => ({ ...look, font: name }))} />
                <PropertyRow label="Size">
                    <FontSizeStepper
                        value={isMixed(size) ? undefined : size}
                        onChange={(pt) => restyle((look) => ({ ...look, size: pt }))}
                        onStep={(by) =>
                            restyle((look) => ({ ...look, size: nextFontSize(look.size ?? normal.size, by) }))
                        }
                    />
                </PropertyRow>
                <PropertyRow label="Style">
                    <div className="flex items-center gap-1">
                        <PropertyToggle
                            aria-label="Bold"
                            pressed={bold === true}
                            onPressedChange={(pressed) => restyle((look) => ({ ...look, bold: pressed }))}
                            data-mixed={isMixed(bold) ? '' : undefined}
                        >
                            <Bold className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            aria-label="Italic"
                            pressed={italic === true}
                            onPressedChange={(pressed) => restyle((look) => ({ ...look, italic: pressed }))}
                            data-mixed={isMixed(italic) ? '' : undefined}
                        >
                            <Italic className="h-4 w-4" />
                        </PropertyToggle>
                    </div>
                </PropertyRow>
            </PropertySection>
        </PropertiesPanel>
    );
}
