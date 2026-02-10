import {useCallback} from "react";
import {ReactEditor, useSlateStatic} from "slate-react";
import {Transforms} from "slate";
import {ResizableMedia, defaultStyleOptions, type MediaStyleOptions, type MediaAlignment} from "@workspace/ui/components/layout/media";
import {CustomElement, TextAlignment} from "./editor.types";

type ResizableImageProps = {
    element: CustomElement;
    src: string;
    isSelected: boolean;
    onSelect: () => void;
    onDeselect: () => void;
}

export function ResizableImage({element, src, isSelected, onSelect, onDeselect}: ResizableImageProps) {
    const editor = useSlateStatic();

    const handleWidthChange = useCallback((width: number) => {
        const path = ReactEditor.findPath(editor, element);
        Transforms.setNodes(editor, {width}, {at: path});
    }, [editor, element]);

    const handleAlignmentChange = useCallback((alignment: MediaAlignment) => {
        const path = ReactEditor.findPath(editor, element);
        Transforms.setNodes(editor, {align: alignment as TextAlignment}, {at: path});
    }, [editor, element]);

    const handleStyleChange = useCallback((style: MediaStyleOptions) => {
        const path = ReactEditor.findPath(editor, element);
        Transforms.setNodes(editor, {style}, {at: path});
    }, [editor, element]);

    const handleDelete = useCallback(() => {
        const path = ReactEditor.findPath(editor, element);
        Transforms.removeNodes(editor, {at: path});
        onDeselect();
    }, [editor, element, onDeselect]);

    return (
        <ResizableMedia
            src={src}
            width={element.width}
            alignment={element.align ?? 'center'}
            styleOptions={element.style ?? defaultStyleOptions}
            isSelected={isSelected}
            onWidthChange={handleWidthChange}
            onAlignmentChange={handleAlignmentChange}
            onStyleChange={handleStyleChange}
            onSelect={onSelect}
            onDeselect={onDeselect}
            onDelete={handleDelete}
        />
    );
}
