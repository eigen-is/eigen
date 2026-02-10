export type MediaAlignment = 'left' | 'center' | 'right';

export type MediaStyleOptions = {
    borderRadius: 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
    shadow: 'none' | 'sm' | 'md' | 'lg' | 'xl';
    border: boolean;
};

export type ResizableMediaProps = {
    src: string;
    alt?: string;
    width?: number;
    minWidth?: number;
    isSelected: boolean;
    alignment?: MediaAlignment;
    styleOptions?: MediaStyleOptions;
    onWidthChange: (width: number) => void;
    onAlignmentChange?: (alignment: MediaAlignment) => void;
    onStyleChange?: (options: MediaStyleOptions) => void;
    onSelect: () => void;
    onDeselect: () => void;
    onDelete?: () => void;
};

export const defaultStyleOptions: MediaStyleOptions = {
    borderRadius: 'sm',
    shadow: 'none',
    border: false,
};
