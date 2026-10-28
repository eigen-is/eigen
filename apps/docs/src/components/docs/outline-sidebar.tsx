// The doc's outline: the body's headings, indented by level, where a click on one jumps to it. A desktop lays it over
// the page's left side, and a phone shows it as a pane that hides the editor. It reads the headings with readOutline
// on every change to the doc, so a heading typed here or by a collaborator shows at once.

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { readOutline } from '@workspace/lib/docs/eigendoc';
import { Column, EmptyState, SidebarItem, ToolbarTitle, TooltipButton, useLayout } from '@workspace/ui';
import { cn } from '@workspace/ui/lib/utils';
import { TableOfContents, X } from 'lucide-react';

type OutlineColumnProps = {
    // The body's editor: a band's or a note's headings are no part of the outline.
    editor: Editor;
    onJump: (pos: number) => void;
    onClose: () => void;
};

// The outline's width on a desktop, which the editor's page-less column starts clear of.
export const OUTLINE_WIDTH_PX = 240;

// Tailwind finds only whole class names, so each level's indent is written out.
const LEVEL_INDENT = ['pl-2.5', 'pl-5', 'pl-7.5', 'pl-10', 'pl-12.5', 'pl-15'];

export function OutlineColumn({ editor, onJump, onClose }: OutlineColumnProps) {
    const { isMobile } = useLayout();
    // Levels and texts only, so typing in a paragraph, which moves the headings below it, draws nothing again.
    const headings = useEditorState({
        editor,
        selector: ({ editor: e }) => readOutline(e.state.doc).map(({ level, text }) => ({ level, text })),
    });
    // The position is read on the click, as an edit above the heading may have moved it since the list was drawn.
    const jump = (index: number) => {
        const heading = readOutline(editor.state.doc)[index];
        if (heading) onJump(heading.pos);
    };

    return (
        <Column
            id="outline"
            width={`${OUTLINE_WIDTH_PX}px`}
            className={cn('bg-background', !isMobile && 'border-r')}
            onBack={onClose}
            toolbarBorder="always"
            toolbar={
                <>
                    <ToolbarTitle>Outline</ToolbarTitle>
                    {/* A phone closes it with the column's own back arrow. */}
                    {!isMobile && (
                        <div className="ml-auto">
                            <TooltipButton icon={X} tooltipText="Close" onClick={onClose} />
                        </div>
                    )}
                </>
            }
        >
            {headings.length === 0 ? (
                <EmptyState
                    icon={<TableOfContents className="h-8 w-8 opacity-40" />}
                    message="Headings you add appear here"
                />
            ) : (
                <nav aria-label="Outline" className="flex h-full flex-col gap-0.5 overflow-y-auto p-2">
                    {headings.map(({ level, text }, index) => (
                        <SidebarItem
                            // An entry holds no state, so a heading's place serves as its key.
                            key={index}
                            icon={null}
                            label={text}
                            className={LEVEL_INDENT[level - 1]}
                            onClick={() => jump(index)}
                        />
                    ))}
                </nav>
            )}
        </Column>
    );
}
