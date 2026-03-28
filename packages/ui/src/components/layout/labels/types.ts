import type { Label } from '@workspace/lib/types/label';

export type LabelManagerProps = {
    labels: Label[];
    getLabelPath?: (label: Label) => string;
    className?: string;
    condensed?: boolean;
    dropAcceptTypes?: string[];
    onItemDrop?: (itemIds: string[], labelId: string) => void;
};
