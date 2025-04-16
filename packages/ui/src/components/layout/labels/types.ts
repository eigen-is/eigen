import type {Label} from "@apps/api-server/types/label";

/**
 * Props for the LabelManager component
 */
export interface LabelManagerProps {
    // Data props
    labels: Label[];

    // Optional path generation function for labels - apps can specify their own routing
    getLabelPath?: (label: Label) => string;

    // Optional className for customizing appearance
    className?: string;

    // Condensed mode flag
    condensed?: boolean;
}
