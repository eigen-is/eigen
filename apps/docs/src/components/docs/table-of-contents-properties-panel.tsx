// The Docs panel for the selected table of contents: how many heading levels it lists, as Word's Show levels
// does. It opens beside the page when the node is selected and writes through the editor that holds it, so its undo
// takes the change back. The write keeps the node selected, so the panel stays open.

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { MAX_HEADING_LEVEL, readTocLevels } from '@workspace/lib/docs/eigendoc';
import {
    MergedSelect,
    numToStr,
    PropertiesPanel,
    PropertyRow,
    PropertySection,
} from '@workspace/ui/components/properties-panel';

const LEVEL_OPTIONS = Array.from({ length: MAX_HEADING_LEVEL }, (_, index) => ({
    value: String(index + 1),
    label: String(index + 1),
}));

export function TableOfContentsPropertiesPanel({ editor }: { editor: Editor }) {
    // useEditor re-renders on no transaction, and a write that keeps the node selected fires no selectionUpdate.
    const levels = useEditorState({
        editor,
        selector: ({ editor: e }) => readTocLevels(e.getAttributes('tableOfContents')['levels']),
    });
    return (
        <PropertiesPanel title="Table of contents">
            <PropertySection title="Heading levels">
                <PropertyRow label="Levels">
                    <MergedSelect
                        value={numToStr(levels)}
                        onChange={(value) => editor.commands.updateTableOfContents({ levels: Number(value) })}
                        options={LEVEL_OPTIONS}
                    />
                </PropertyRow>
            </PropertySection>
        </PropertiesPanel>
    );
}
