export type MediaStyleOptions = {
    borderRadius: 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
    shadow: 'none' | 'sm' | 'md' | 'lg' | 'xl';
};

export type ResizableMediaProps = {
    src: string;
    alt?: string;
    width?: number;
    minWidth?: number;
    isSelected: boolean;
    styleOptions?: MediaStyleOptions;
    onWidthChange: (width: number) => void;
    onSelect: () => void;
    onDeselect: () => void;
    onDelete?: () => void;
};

export const defaultStyleOptions: MediaStyleOptions = {
    borderRadius: 'sm',
    shadow: 'none',
};
