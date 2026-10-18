import { type Editor, useEditorState } from '@tiptap/react';
import { readCellBackground } from '@workspace/lib/docs/eigendoc';
import { Button } from '@workspace/ui/components/button';
import { ColorRow, PropertiesPanel, PropertySection } from '@workspace/ui/components/properties-panel';
import { cellBackground, selectCellCommands } from './hooks/use-toolbar-state';
import { TABLE_ACTION_ICONS } from './table-action-icons';

type TablePropertiesPanelProps = {
    editor: Editor;
};

export function TablePropertiesPanel({ editor }: TablePropertiesPanelProps) {
    // The panel stays mounted through its exit, so a caret that has left the table reads no cell command.
    const { canMergeCells, canSplitCell, fill } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const inTable = e.isActive('table');
            return { ...selectCellCommands(e, inTable), fill: inTable ? cellBackground(e.state) : '' };
        },
    });
    return (
        <PropertiesPanel title="Table">
            <PropertySection title="Columns">
                <div className="grid grid-cols-2 gap-1.5">
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => editor.chain().focus().addColumnBefore().run()}
                    >
                        <TABLE_ACTION_ICONS.addColumnBefore className="h-3.5 w-3.5 mr-1" /> Before
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => editor.chain().focus().addColumnAfter().run()}
                    >
                        <TABLE_ACTION_ICONS.addColumnAfter className="h-3.5 w-3.5 mr-1" /> After
                    </Button>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => editor.chain().focus().deleteColumn().run()}
                >
                    <TABLE_ACTION_ICONS.deleteColumn className="h-3.5 w-3.5 mr-1" /> Delete column
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => editor.chain().focus().distributeColumns().run()}
                >
                    <TABLE_ACTION_ICONS.distributeColumns className="h-3.5 w-3.5 mr-1" /> Distribute columns
                </Button>
            </PropertySection>

            <PropertySection title="Rows">
                <div className="grid grid-cols-2 gap-1.5">
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => editor.chain().focus().addRowBefore().run()}
                    >
                        <TABLE_ACTION_ICONS.addRowBefore className="h-3.5 w-3.5 mr-1" /> Before
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => editor.chain().focus().addRowAfter().run()}
                    >
                        <TABLE_ACTION_ICONS.addRowAfter className="h-3.5 w-3.5 mr-1" /> After
                    </Button>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => editor.chain().focus().deleteRow().run()}
                >
                    <TABLE_ACTION_ICONS.deleteRow className="h-3.5 w-3.5 mr-1" /> Delete row
                </Button>
            </PropertySection>

            <PropertySection title="Cells">
                <div className="grid grid-cols-2 gap-1.5">
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        disabled={!canMergeCells}
                        onClick={() => editor.chain().focus().mergeCells().run()}
                    >
                        <TABLE_ACTION_ICONS.mergeCells className="h-3.5 w-3.5 mr-1" /> Merge
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        disabled={!canSplitCell}
                        onClick={() => editor.chain().focus().splitCell().run()}
                    >
                        <TABLE_ACTION_ICONS.splitCell className="h-3.5 w-3.5 mr-1" /> Unmerge
                    </Button>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => editor.chain().focus().toggleHeaderRow().run()}
                >
                    <TABLE_ACTION_ICONS.toggleHeaderRow className="h-3.5 w-3.5 mr-1" /> Toggle header row
                </Button>
                {/* None writes the transparent token, which reads as no fill. */}
                <ColorRow
                    label="Fill"
                    value={fill}
                    allowNone
                    onChange={(color) =>
                        editor.chain().focus().setCellAttribute('backgroundColor', readCellBackground(color)).run()
                    }
                />
            </PropertySection>

            <div className="app-gutter">
                <Button
                    variant="destructive"
                    size="sm"
                    className="w-full"
                    onClick={() => editor.chain().focus().deleteTable().run()}
                >
                    <TABLE_ACTION_ICONS.deleteTable className="h-3.5 w-3.5 mr-1.5" /> Delete table
                </Button>
            </div>
        </PropertiesPanel>
    );
}
