import {
    AlignCenter,
    AlignLeft,
    AlignRight,
    AlignVerticalJustifyCenter,
    AlignVerticalJustifyEnd,
    AlignVerticalJustifyStart,
    ArrowDownNarrowWide,
    ArrowUpNarrowWide,
    Baseline,
    Bold,
    Camera,
    Check,
    ChevronDown,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    CircleChevronDown,
    Columns3,
    Copy,
    Ellipsis,
    Eraser,
    Euro,
    EyeOff,
    FileCode2,
    Filter,
    FunctionSquare,
    Grid2x2,
    Grid3x3,
    Highlighter,
    ImagePlus,
    Italic,
    LayoutGrid,
    Link,
    Locate,
    type LucideIcon,
    MessageSquare,
    Minus,
    MoveRight,
    Paintbrush,
    Pencil,
    Percent,
    Plus,
    Redo,
    RemoveFormatting,
    Scissors,
    Search,
    ShieldCheck,
    Sigma,
    Snowflake,
    Strikethrough,
    Table,
    TableCellsMerge,
    Underline,
    Undo,
    Unlink,
    WrapText,
    X,
} from "lucide-react";
import type {CSSProperties} from "react";
import React from "react";

export const ICON_MAP: Record<string, LucideIcon> = {
    // Toolbar actions
    undo: Undo,
    redo: Redo,
    "format-painter": Paintbrush,
    "clear-format": RemoveFormatting,

    // Text formatting
    bold: Bold,
    italic: Italic,
    "strike-through": Strikethrough,
    underline: Underline,

    // Alignment
    "align-left": AlignLeft,
    "align-center": AlignCenter,
    "align-right": AlignRight,
    "align-top": AlignVerticalJustifyStart,
    "align-middle": AlignVerticalJustifyCenter,
    "align-bottom": AlignVerticalJustifyEnd,

    // Borders
    "border-all": Grid3x3,
    border: Grid3x3,

    // Merge
    "merge-all": TableCellsMerge,
    "merge-horizontal": TableCellsMerge,
    "merge-vertical": TableCellsMerge,
    "merge-cancel": TableCellsMerge,

    // Sort & filter
    "sort-asc": ArrowUpNarrowWide,
    "sort-desc": ArrowDownNarrowWide,
    sort: ArrowUpNarrowWide,
    filter: Filter,
    filter1: Filter,
    eraser: Eraser,

    // Number formats
    "currency-format": Euro,
    "percentage-format": Percent,
    "number-decrease": Minus,
    "number-increase": Plus,

    // Text layout
    "text-wrap": WrapText,
    "text-clip": Scissors,
    "text-overflow": MoveRight,

    // Freeze panes
    "freeze-row-col": Snowflake,
    "freeze-row": Snowflake,
    "freeze-col": Snowflake,
    "freeze-cancel": Snowflake,

    // Tools
    search: Search,
    screenshot: Camera,
    splitColumn: Columns3,
    dataVerification: ShieldCheck,
    image: ImagePlus,
    "formula-sum": Sigma,
    comment: MessageSquare,
    conditionFormat: FileCode2,
    locationCondition: Locate,

    // Colors
    "font-color": Baseline,
    background: Highlighter,

    // Navigation / UI
    link: Link,
    copy: Copy,
    pencil: Pencil,
    unlink: Unlink,
    close: X,
    fx: FunctionSquare,
    tab: Table,
    check: Check,
    hidden: EyeOff,
    plus: Plus,
    minus: Minus,
    "combo-arrow": ChevronDown,
    downArrow: ChevronDown,
    rightArrow: ChevronRight,
    headDownArrow: CircleChevronDown,
    "arrow-doubleleft": ChevronsLeft,
    "arrow-doubleright": ChevronsRight,
    "all-sheets": LayoutGrid,
    default: Grid2x2,
    more: Ellipsis,
};

// Text rotation icons - custom inline SVGs since Lucide has no equivalent
const TextRotationNone: LucideIcon = React.forwardRef(({className, ...props}: any, ref: any) => (
    <svg ref={ref} className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none" {...props}>
        <path
            d="M657.07 620.09c24.18 0 39.82-24.18 31.29-46.93L509.16 150.76c-14.22-34.13-64-34.13-78.22 0L250.31 573.16c-9.96 22.75 7.11 46.93 31.29 46.93 14.22 0 25.6-8.53 31.29-21.33l36.98-92.44h240.36l36.98 92.44c4.27 12.8 17.07 21.33 29.87 21.33zm-285.87-170.67L469.33 203.38l98.13 246.04H371.2zM704 662.76c-11.38 11.38-11.38 28.44 0 39.82l45.51 45.51H204.8c-15.64 0-28.44 12.8-28.44 28.44s12.8 28.44 28.44 28.44h544.71l-45.51 45.51c-11.38 11.38-11.38 28.44 0 39.82 11.38 11.38 28.44 11.38 39.82 0L839.11 796.44c11.38-11.38 11.38-28.44 0-39.82l-93.87-93.87c-11.38-11.38-29.87-11.38-41.24 0z"
            transform="scale(0.0234375)"/>
    </svg>
)) as any;
TextRotationNone.displayName = "TextRotationNone";

const TextRotationAngleUp: LucideIcon = React.forwardRef(({className, ...props}: any, ref: any) => (
    <svg ref={ref} className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none" {...props}>
        <path
            d="M634.31 398.22c17.07-17.07 11.38-45.51-11.38-54.04L196.27 170.67c-35.56-14.22-69.69 21.33-55.47 55.47l172.09 426.67c8.53 22.76 38.4 28.44 54.04 11.38 9.96-9.96 12.8-24.18 7.11-36.98l-39.82-91.02 170.67-170.67 91.02 39.82c12.8 4.27 28.44 2.84 38.4-7.11zm-322.84 81.07l-105.24-243.2L449.42 341.33l-137.96 137.96zM696.89 393.96c0 15.64 12.8 28.44 28.44 28.44h64L403.91 807.82c-11.38 11.38-11.38 28.44 0 39.82 11.38 11.38 28.44 11.38 39.82 0l385.42-385.42V526.22c0 15.64 12.8 28.44 28.44 28.44s28.44-12.8 28.44-28.44v-133.69c0-15.64-12.8-28.44-28.44-28.44h-133.69c-14.22 1.42-27.02 14.22-27.02 29.87z"
            transform="scale(0.0234375)"/>
    </svg>
)) as any;
TextRotationAngleUp.displayName = "TextRotationAngleUp";

const TextRotationAngleDown: LucideIcon = React.forwardRef(({className, ...props}: any, ref: any) => (
    <svg ref={ref} className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none" {...props}>
        <path
            d="M625.78 634.31c17.07 17.07 45.51 11.38 54.04-11.38l172.09-426.67c14.22-35.56-21.33-69.69-55.47-55.47L371.2 312.89c-22.76 8.53-28.44 38.4-11.38 54.04 9.96 9.96 24.18 12.8 36.98 7.11l91.02-39.82 170.67 170.67-39.82 92.44c-4.27 11.38-2.84 27.02 7.11 36.98zm-81.07-322.84l243.2-105.24L682.67 449.42l-137.96-137.96zM630.04 696.89c-15.64 0-28.44 12.8-28.44 28.44v64L216.18 403.91c-11.38-11.38-28.44-11.38-39.82 0-11.38 11.38-11.38 28.44 0 39.82l385.42 385.42H497.78c-15.64 0-28.44 12.8-28.44 28.44s12.8 28.44 28.44 28.44h133.69c15.64 0 28.44-12.8 28.44-28.44v-133.69c-1.42-14.22-14.22-27.02-29.87-27.02z"
            transform="scale(0.0234375)"/>
    </svg>
)) as any;
TextRotationAngleDown.displayName = "TextRotationAngleDown";

const TextRotationVertical: LucideIcon = React.forwardRef(({className, ...props}: any, ref: any) => (
    <svg ref={ref} className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none" {...props}>
        <path
            d="M465.07 672.71c-24.18 0-39.82-24.18-31.29-46.93l179.2-423.82c14.22-34.13 64-34.13 78.22 0L871.82 625.78c9.96 22.76-7.11 46.93-31.29 46.93-14.22 0-25.6-8.53-31.29-21.33l-36.98-92.44H531.91l-36.98 92.44c-4.27 12.8-17.07 21.33-29.87 21.33zm285.87-170.67L652.8 256 554.67 502.04h196.27zM157.87 704c11.38-11.38 28.44-11.38 39.82 0l45.51 45.51V204.8c0-15.64 12.8-28.44 28.44-28.44s28.44 12.8 28.44 28.44v544.71l45.51-45.51c11.38-11.38 28.44-11.38 39.82 0 11.38 11.38 11.38 28.44 0 39.82L292.98 839.11c-11.38 11.38-28.44 11.38-39.82 0l-93.87-93.87c-12.8-11.38-12.8-29.87-1.42-41.24z"
            transform="scale(0.0234375)"/>
    </svg>
)) as any;
TextRotationVertical.displayName = "TextRotationVertical";

const TextRotationUp: LucideIcon = React.forwardRef(({className, ...props}: any, ref: any) => (
    <svg ref={ref} className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none" {...props}>
        <path
            d="M620.09 366.93c0-24.18-24.18-39.82-46.93-31.29L150.76 514.84c-34.13 14.22-34.13 64 0 78.22l423.82 179.2c22.76 9.96 46.93-7.11 46.93-31.29 0-14.22-8.53-25.6-21.33-31.29l-92.44-36.98V433.78l92.44-36.98c11.38-4.27 19.91-17.07 19.91-29.87zm-170.67 285.87L203.38 554.67l246.04-98.13v196.27zM662.76 320c11.38 11.38 28.44 11.38 39.82 0l45.51-45.51v544.71c0 15.64 12.8 28.44 28.44 28.44s28.44-12.8 28.44-28.44V274.49l45.51 45.51c11.38 11.38 28.44 11.38 39.82 0 11.38-11.38 11.38-28.44 0-39.82L796.44 184.89c-11.38-11.38-28.44-11.38-39.82 0l-93.87 93.87c-11.38 11.38-11.38 29.87 0 41.24z"
            transform="scale(0.0234375)"/>
    </svg>
)) as any;
TextRotationUp.displayName = "TextRotationUp";

const TextRotationDown: LucideIcon = React.forwardRef(({className, ...props}: any, ref: any) => (
    <svg ref={ref} className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none" {...props}>
        <path
            d="M403.91 657.07c0 24.18 24.18 39.82 46.93 31.29L873.24 509.16c34.13-14.22 34.13-64 0-78.22L450.84 250.31c-22.76-9.96-46.93 7.11-46.93 31.29 0 14.22 8.53 25.6 21.33 31.29l92.44 36.98v240.36l-92.44 36.98c-12.8 4.27-21.33 17.07-21.33 29.87zm170.67-285.87L820.62 469.33 574.58 567.47V371.2zM361.24 704c-11.38-11.38-28.44-11.38-39.82 0l-45.51 45.51V204.8c0-15.64-12.8-28.44-28.44-28.44s-28.44 12.8-28.44 28.44v544.71l-45.51-45.51c-11.38-11.38-28.44-11.38-39.82 0-11.38 11.38-11.38 28.44 0 39.82L227.56 839.11c11.38 11.38 28.44 11.38 39.82 0l93.87-93.87c11.38-11.38 11.38-29.87 0-41.24z"
            transform="scale(0.0234375)"/>
    </svg>
)) as any;
TextRotationDown.displayName = "TextRotationDown";

// Filter filled variants
const FilterFilled: LucideIcon = React.forwardRef(({className, ...props}: any, ref: any) => (
    <svg ref={ref} className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none" {...props}>
        <path
            d="M18.14 4a1.5 1.5 0 0 1 1.16 2.44L14.7 12.15v6.4l-5.37-2.56v-3.96L4.5 6.31A1.5 1.5 0 0 1 5.76 4h12.38z"/>
    </svg>
)) as any;
FilterFilled.displayName = "FilterFilled";

const FilterFilledWhite: LucideIcon = React.forwardRef(({className, ...props}: any, ref: any) => (
    <svg ref={ref} className={className} viewBox="0 0 24 24" fill="white" stroke="none" {...props}>
        <path
            d="M18.14 4a1.5 1.5 0 0 1 1.16 2.44L14.7 12.15v6.4l-5.37-2.56v-3.96L4.5 6.31A1.5 1.5 0 0 1 5.76 4h12.38z"/>
    </svg>
)) as any;
FilterFilledWhite.displayName = "FilterFilledWhite";

// Border-specific icons (no Lucide equivalents)
const BorderStyle: LucideIcon = React.forwardRef(({className, ...props}: any, ref: any) => (
    <svg ref={ref} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" {...props}>
        <line x1="5" y1="5.75" x2="19" y2="5.75"/>
        <line x1="5" y1="12.25" x2="7.5" y2="12.25"/>
        <line x1="8.8" y1="12.25" x2="11.3" y2="12.25"/>
        <line x1="12.6" y1="12.25" x2="15.1" y2="12.25"/>
        <line x1="16.5" y1="12.25" x2="19" y2="12.25"/>
        <line x1="5" y1="18.25" x2="6.5" y2="18.25"/>
        <line x1="7.1" y1="18.25" x2="8.6" y2="18.25"/>
        <line x1="9.2" y1="18.25" x2="10.7" y2="18.25"/>
        <line x1="11.2" y1="18.25" x2="12.7" y2="18.25"/>
        <line x1="13.3" y1="18.25" x2="14.8" y2="18.25"/>
        <line x1="15.4" y1="18.25" x2="16.9" y2="18.25"/>
        <line x1="17.5" y1="18.25" x2="19" y2="18.25"/>
    </svg>
)) as any;
BorderStyle.displayName = "BorderStyle";

// Add text-rotation and filter-fill to the main map
ICON_MAP["text-rotation-none"] = TextRotationNone;
ICON_MAP["text-rotation-angleup"] = TextRotationAngleUp;
ICON_MAP["text-rotation-angledown"] = TextRotationAngleDown;
ICON_MAP["text-rotation-vertical"] = TextRotationVertical;
ICON_MAP["text-rotation-up"] = TextRotationUp;
ICON_MAP["text-rotation-down"] = TextRotationDown;
ICON_MAP["filter-fill"] = FilterFilled;
ICON_MAP["filter-fill-white"] = FilterFilledWhite;
ICON_MAP["border-style"] = BorderStyle;

export function SheetIcon({name, width = 24, height = 24, style, className}: {
    name: string;
    width?: number;
    height?: number;
    style?: CSSProperties;
    className?: string;
}) {
    const Icon = ICON_MAP[name];
    if (!Icon) return null;
    return <Icon width={width} height={height} style={style} className={className} aria-hidden="true"/>;
}

export {SheetIcon as SVGIcon};

