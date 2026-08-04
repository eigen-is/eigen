import type { Editor } from '@tiptap/react';
import { Button } from '@workspace/ui/components/button';
import { PropertiesPanel, PropertySection } from '@workspace/ui/components/layout/properties-panel';
import { Columns2, GripHorizontal, GripVertical, Merge, RowsIcon, Split, ToggleLeft, Trash2 } from 'lucide-react';

type TablePropertiesPanelProps = {
    editor: Editor;
};

export function TablePropertiesPanel({ editor }: TablePropertiesPanelProps) {
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
                        <Columns2 className="h-3.5 w-3.5 mr-1" /> Before
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => editor.chain().focus().addColumnAfter().run()}
                    >
                        <Columns2 className="h-3.5 w-3.5 mr-1" /> After
                    </Button>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => editor.chain().focus().deleteColumn().run()}
                >
                    <GripVertical className="h-3.5 w-3.5 mr-1" /> Delete column
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
                        <RowsIcon className="h-3.5 w-3.5 mr-1" /> Before
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => editor.chain().focus().addRowAfter().run()}
                    >
                        <RowsIcon className="h-3.5 w-3.5 mr-1" /> After
                    </Button>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => editor.chain().focus().deleteRow().run()}
                >
                    <GripHorizontal className="h-3.5 w-3.5 mr-1" /> Delete row
                </Button>
            </PropertySection>

            <PropertySection title="Cells">
                <div className="grid grid-cols-2 gap-1.5">
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => editor.chain().focus().mergeCells().run()}
                    >
                        <Merge className="h-3.5 w-3.5 mr-1" /> Merge
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => editor.chain().focus().splitCell().run()}
                    >
                        <Split className="h-3.5 w-3.5 mr-1" /> Split
                    </Button>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => editor.chain().focus().toggleHeaderRow().run()}
                >
                    <ToggleLeft className="h-3.5 w-3.5 mr-1" /> Toggle header row
                </Button>
            </PropertySection>

            <div className="px-3 py-3">
                <Button
                    variant="destructive"
                    size="sm"
                    className="w-full"
                    onClick={() => editor.chain().focus().deleteTable().run()}
                >
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete table
                </Button>
            </div>
        </PropertiesPanel>
    );
}
