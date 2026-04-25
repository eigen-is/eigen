import {isNil, sortBy} from "es-toolkit/compat";
import {SheetConfig} from ".";
import {FormulaCache} from "./modules";
import {normalizeSelection} from "./modules/selection";
import {Hooks} from "./settings";
import type {Cell} from "../engine/types";
import {
    ConditionRulesProps,
    DataRegulationProps,
    FilterOptions,
    GlobalCache,
    Image,
    LinkCardProps,
    Presence,
    RangeDialogProps,
    Rect,
    Selection,
    Sheet,
} from "./types";
import {getSheetIndex} from "./utils";

interface MutableRefObject<T> {
    current: T;
}

type RefValues = {
    globalCache: GlobalCache;
    cellInput: MutableRefObject<HTMLDivElement | null>;
    fxInput: MutableRefObject<HTMLDivElement | null>;
    canvas: MutableRefObject<HTMLCanvasElement | null>;
    cellArea: MutableRefObject<HTMLDivElement | null>;
    workbookContainer: MutableRefObject<HTMLDivElement | null>;
};

export type Context = {
    luckysheetfile: Sheet[];
    defaultcolumnNum: number;
    defaultrowNum: number;
    addDefaultRows: number;
    fullscreenmode: boolean;
    devicePixelRatio: number;
    insertedImgs?: Image[];
    editingInsertedImgs?: Image;
    activeImg?: string;
    presences?: Presence[];
    showSearch?: boolean;
    showReplace?: boolean;
    linkCard?: LinkCardProps;
    rangeDialog?: RangeDialogProps; // coordinate range mouse selection
    // warning dialog
    warnDialog?: string;
    currency?: string;
    dataVerification?: {
        selectStatus: boolean;
        selectRange: [];
        optionLabel_en: any; // English hint message
        optionLabel_zh: any; // Chinese hint message
        optionLabel_zh_tw: any; // Chinese (Traditional) hint message
        optionLabel_es: any; // Spanish hint message
        optionLabel_hi: any;
        optionLabel_ru: any;
        dataRegulation?: DataRegulationProps; // data validation rule
    };
    // data validation dropdown list
    dataVerificationDropDownList?: boolean;
    conditionRules: ConditionRulesProps; // conditional formatting

    contextMenu: {
        x?: number;
        y?: number;
        headerMenu?: boolean;
        pageX?: number;
        pageY?: number;
    };
    filterContextMenu?: {
        x: number;
        y: number;
        col: number;
        startRow: number;
        endRow: number;
        startCol: number;
        endCol: number;
        hiddenRows: number[];
        listBoxMaxHeight: number;
    };

    currentSheetId: string;
    calculateSheetId: string;
    config: SheetConfig;

    visibledatarow: number[];
    visibledatacolumn: number[];
    ch_width: number;
    rh_height: number;

    cellmainWidth: number;
    cellmainHeight: number;
    toolbarHeight: number;
    infobarHeight: number;
    calculatebarHeight: number;
    rowHeaderWidth: number;
    columnHeaderHeight: number;
    cellMainSrollBarSize: number;
    sheetBarHeight: number;
    statisticBarHeight: number;
    luckysheetTableContentHW: number[];

    defaultcollen: number;
    defaultrowlen: number;

    scrollLeft: number;
    scrollTop: number;

    sheetScrollRecord: Record<string, any>;

    luckysheet_select_status: boolean;
    luckysheet_select_save: Sheet["luckysheet_select_save"];
    luckysheet_selection_range: Sheet["luckysheet_selection_range"];
    formulaRangeHighlight: ({
        rangeIndex: number;
        backgroundColor: string;
    } & Rect)[];
    formulaRangeSelect: ({ rangeIndex: number } & Rect) | undefined;
    functionCandidates: any[];
    functionHint: string | null | undefined;

    luckysheet_copy_save?: {
        dataSheetId: string;
        copyRange: { row: number[]; column: number[] }[];
        RowlChange: boolean;
        HasMC: boolean;
    }; // copy/paste
    luckysheet_paste_iscut: boolean;

    filterchage: boolean; // filter
    filterOptions?: FilterOptions;
    luckysheet_filter_save?: { row: number[]; column: number[] } | undefined;
    filter: Record<
        string,
        {
            caljs: any;
            rowhidden: Record<string, number>;
            optionstate: boolean;
            str: number;
            edr: number;
            cindex: number;
            stc: number;
            edc: number;
        }
    >;

    luckysheet_sheet_move_status: boolean;
    luckysheet_sheet_move_data: any[];
    luckysheet_scroll_status: boolean;

    luckysheetcurrentisPivotTable: boolean;

    luckysheet_rows_selected_status: boolean; // row/column header related parameters
    luckysheet_cols_selected_status: boolean;
    luckysheet_rows_change_size: boolean;
    luckysheet_rows_change_size_start: any[];
    luckysheet_cols_change_size: boolean;
    luckysheet_cols_change_size_start: any[];
    luckysheet_cols_freeze_drag: boolean;
    luckysheet_rows_freeze_drag: boolean;

    luckysheetCellUpdate: any[];

    luckysheet_shiftkeydown: boolean;
    luckysheet_shiftpositon: Selection | undefined;

    iscopyself: boolean;

    orderbyindex: number; // sort index

    luckysheet_model_move_state: boolean; // modal drag
    luckysheet_model_xy: number[];
    luckysheet_model_move_obj: any;

    luckysheet_cell_selected_move: boolean; // selection drag-replace
    luckysheet_cell_selected_move_index: any[];

    luckysheet_cell_selected_extend: boolean; // selection fill-down
    luckysheet_cell_selected_extend_index: any[];

    lang: string | null; // language

    chart_selection: any;

    zoomRatio: number;

    showGridLines: boolean;
    allowEdit: boolean;

    fontList: any[];
    defaultFontSize: number;

    luckysheetPaintModelOn: boolean;
    luckysheetPaintSingle: boolean;

    // default cell
    defaultCell: Cell;

    groupValuesRefreshData: {
        r: number;
        c: number;
        v: Cell["v"];
        f: string;
        id: string;
    }[];
    formulaCache: FormulaCache;
    hooks: Hooks;
    // in read-only mode, force-highlight cells referenced by formulas
    forceFormulaRef?: Boolean;

    sheetFocused: boolean; // property to track sheet focus for keyboard navigation

    getRefs: () => RefValues;
};

export function defaultContext(refs: RefValues): Context {
    return {
        luckysheetfile: [],
        defaultcolumnNum: 60,
        defaultrowNum: 84,
        addDefaultRows: 50,
        fullscreenmode: true,
        devicePixelRatio: (typeof globalThis !== "undefined" ? globalThis : window)
            .devicePixelRatio,

        contextMenu: {},

        currentSheetId: "",
        calculateSheetId: "",
        config: {},
        // warning dialog
        warnDialog: undefined,
        currency: "€",
        rangeDialog: {
            show: false,
            rangeTxt: "",
            type: "",
            singleSelect: false,
        },

        dataVerification: {
            selectStatus: false,
            selectRange: [],
            optionLabel_en: {
                number: "numeric",
                number_integer: "integer",
                number_decimal: "decimal",
                between: "between",
                notBetween: "not between",
                equal: "equal to",
                notEqualTo: "not equal to",
                moreThanThe: "greater",
                lessThan: "less than",
                greaterOrEqualTo: "greater or equal to",
                lessThanOrEqualTo: "less than or equal to",
                include: "include",
                exclude: "not include",
                earlierThan: "earlier than",
                noEarlierThan: "not earlier than",
                laterThan: "later than",
                noLaterThan: "not later than",
                identificationNumber: "identification number",
                phoneNumber: "phone number",
            },
            optionLabel_ru: {
                number: "числовое",
                number_integer: "целое число",
                number_decimal: "десятичное число",
                between: "между",
                notBetween: "не между",
                equal: "равно",
                notEqualTo: "не равно",
                moreThanThe: "больше",
                lessThan: "меньше",
                greaterOrEqualTo: "больше или равно",
                lessThanOrEqualTo: "меньше или равно",
                include: "содержит",
                exclude: "не содержит",
                earlierThan: "раньше",
                noEarlierThan: "не раньше",
                laterThan: "позже",
                noLaterThan: "не позже",
                identificationNumber: "идентификационный номер",
                phoneNumber: "номер телефона",
            },
            optionLabel_hi: {
                number: "संख्यात्मक",
                number_integer: "पूर्णांक",
                number_decimal: "दशमलव",
                between: "के बीच",
                notBetween: "के बीच नहीं",
                equal: "के बराबर",
                notEqualTo: "के बराबर नहीं",
                moreThanThe: "से अधिक",
                lessThan: "से कम",
                greaterOrEqualTo: "के बराबर या अधिक",
                lessThanOrEqualTo: "के बराबर या कम",
                include: "शामिल",
                exclude: "शामिल नहीं",
                earlierThan: "से पहले",
                noEarlierThan: "से पहले नहीं",
                laterThan: "के बाद",
                noLaterThan: "के बाद नहीं",
                identificationNumber: "पहचान संख्या",
                phoneNumber: "फोन नंबर",
            },
            optionLabel_zh: {
                number: "数值",
                number_integer: "整数",
                number_decimal: "小数",
                between: "介于",
                notBetween: "不介于",
                equal: "等于",
                notEqualTo: "不等于",
                moreThanThe: "大于",
                lessThan: "小于",
                greaterOrEqualTo: "大于等于",
                lessThanOrEqualTo: "小于等于",
                include: "包括",
                exclude: "不包括",
                earlierThan: "早于",
                noEarlierThan: "不早于",
                laterThan: "晚于",
                noLaterThan: "不晚于",
                identificationNumber: "身份证号码",
                phoneNumber: "手机号",
            },
            optionLabel_zh_tw: {
                number: "數位",
                number_integer: "數位-整數",
                number_decimal: "數位-小數",
                between: "介於",
                notBetween: "不介於",
                equal: "等於",
                notEqualTo: "不等於",
                moreThanThe: "大於",
                lessThan: "小於",
                greaterOrEqualTo: "大於等於",
                lessThanOrEqualTo: "小於等於",
                include: "包括",
                exclude: "不包括",
                earlierThan: "早於",
                noEarlierThan: "不早於",
                laterThan: "晚於",
                noLaterThan: "不晚於",
                identificationNumber: "身份證號碼",
                phoneNumber: "手機號",
            },
            optionLabel_es: {
                number: "Número",
                number_integer: "Número entero",
                number_decimal: "Número decimal",
                between: "Entre",
                notBetween: "No entre",
                equal: "Iqual",
                notEqualTo: "No iqual a",
                moreThanThe: "Más que el",
                lessThan: "Menos que",
                greaterOrEqualTo: "Mayor o igual a",
                lessThanOrEqualTo: "Menor o igual a",
                include: "Incluir",
                exclude: "Excluir",
                earlierThan: "Antes de",
                noEarlierThan: "No antes de",
                laterThan: "Después de",
                noLaterThan: "No después de",
                identificationNumber: "Número de identificación",
                phoneNumber: "Número de teléfono",
            },
            dataRegulation: {
                type: "",
                type2: "",
                rangeTxt: "",
                value1: "",
                value2: "",
                validity: "",
                remote: false,
                prohibitInput: false,
                hintShow: false,
                hintValue: "",
            },
        },

        dataVerificationDropDownList: false,

        conditionRules: {
            rulesType: "",
            rulesValue: "",
            textColor: {check: true, color: "#000000"},
            cellColor: {check: true, color: "#000000"},
            betweenValue: {value1: "", value2: ""},
            dateValue: "",
            repeatValue: "0",
            projectValue: "10",
        },

        visibledatarow: [],
        visibledatacolumn: [],
        ch_width: 0,
        rh_height: 0,

        cellmainWidth: 0,
        cellmainHeight: 0,
        toolbarHeight: 41,
        infobarHeight: 57,
        calculatebarHeight: 29,
        rowHeaderWidth: 46,
        columnHeaderHeight: 20,
        cellMainSrollBarSize: 12,
        sheetBarHeight: 31,
        statisticBarHeight: 23,
        luckysheetTableContentHW: [0, 0],

        defaultcollen: 73,
        defaultrowlen: 19,

        scrollLeft: 0,
        scrollTop: 0,

        sheetScrollRecord: {},

        luckysheet_select_status: false,
        luckysheet_select_save: undefined,
        luckysheet_selection_range: [],
        formulaRangeHighlight: [],
        formulaRangeSelect: undefined,
        functionCandidates: [],
        functionHint: null,

        luckysheet_copy_save: undefined, // copy/paste
        luckysheet_paste_iscut: false,

        filterchage: true, // filter
        filter: {},

        luckysheet_sheet_move_status: false,
        luckysheet_sheet_move_data: [],
        luckysheet_scroll_status: false,

        luckysheetcurrentisPivotTable: false,

        luckysheet_rows_selected_status: false, // row/column header related parameters
        luckysheet_cols_selected_status: false,
        luckysheet_rows_change_size: false,
        luckysheet_rows_change_size_start: [],
        luckysheet_cols_change_size: false,
        luckysheet_cols_change_size_start: [],
        luckysheet_cols_freeze_drag: false,
        luckysheet_rows_freeze_drag: false,

        luckysheetCellUpdate: [],

        luckysheet_shiftkeydown: false,
        luckysheet_shiftpositon: undefined,

        iscopyself: true,
        activeImg: undefined,

        orderbyindex: 0, // sort index

        luckysheet_model_move_state: false, // modal drag
        luckysheet_model_xy: [0, 0],
        luckysheet_model_move_obj: null,

        luckysheet_cell_selected_move: false, // selection drag-replace
        luckysheet_cell_selected_move_index: [],

        luckysheet_cell_selected_extend: false, // selection fill-down
        luckysheet_cell_selected_extend_index: [],

        lang: null, // language
        chart_selection: {},

        zoomRatio: 1,

        showGridLines: true,
        allowEdit: true,

        fontList: [],
        defaultFontSize: 10,

        luckysheetPaintModelOn: false,
        luckysheetPaintSingle: false,

        sheetFocused: true,

        // default cell
        defaultCell: {
            bl: 0,
            ct: {fa: "General", t: "n"},
            fc: "rgb(51, 51, 51)",
            ff: 0,
            fs: 11,
            ht: 1,
            it: 0,
            vt: 1,
            m: "",
            v: "",
        },

        groupValuesRefreshData: [],
        formulaCache: new FormulaCache(), // class will not be frozen by immer, can be mutated at any time.
        hooks: {},

        getRefs: () => refs,
    };
}

export function getFlowdata(ctx?: Context, id?: string | null) {
    if (!ctx) return null;
    const i = getSheetIndex(ctx, id || ctx.currentSheetId);
    if (isNil(i)) {
        return null;
    }
    return ctx.luckysheetfile?.[i]?.data;
}

function calcRowColSize(ctx: Context, rowCount: number, colCount: number) {
    ctx.visibledatarow = [];
    ctx.rh_height = 0;

    for (let r = 0; r < rowCount; r += 1) {
        let rowlen: number | string = ctx.defaultrowlen;

        if (ctx.config.rowlen?.[r]) {
            rowlen = ctx.config?.rowlen?.[r];
        }

        if (ctx.config?.rowhidden?.[r] != null) {
            ctx.visibledatarow.push(ctx.rh_height);
            continue;
        }

        // auto row height calculation
        // if (rowlen === "auto") {
        //   rowlen = computeRowlenByContent(ctx.flowdata, r);
        // }
        ctx.rh_height += Math.round(((rowlen as number) + 1) * ctx.zoomRatio);

        ctx.visibledatarow.push(ctx.rh_height); // temporary row height distribution
    }

    // if add-row and back-to-top buttons are hidden, reduce the bottom blank area,
    // but keep enough space for cell dropdown buttons
    // if (
    //   !luckysheetConfigsetting.enableAddRow &&
    //   !luckysheetConfigsetting.enableAddBackTop
    // ) {
    //   ctx.rh_height += 29;
    // } else {
    // }
    ctx.rh_height += 80; // add blank space at the very bottom

    ctx.visibledatacolumn = [];
    ctx.ch_width = 0;

    const maxColumnlen = 120;

    const flowdata = getFlowdata(ctx);
    for (let c = 0; c < colCount; c += 1) {
        let firstcolumnlen: number | string = ctx.defaultcollen;

        if (ctx.config?.columnlen?.[c]) {
            firstcolumnlen = ctx.config.columnlen[c];
        } else {
            if (flowdata?.[0]?.[c]) {
                if (firstcolumnlen > 300) {
                    firstcolumnlen = 300;
                } else if (firstcolumnlen < ctx.defaultcollen) {
                    firstcolumnlen = ctx.defaultcollen;
                }

                if (firstcolumnlen !== ctx.defaultcollen) {
                    if (!ctx.config?.columnlen) {
                        ctx.config.columnlen = {};
                    }

                    ctx.config.columnlen[c] = firstcolumnlen;
                }
            }
        }

        if (ctx.config?.colhidden?.[c] != null) {
            ctx.visibledatacolumn.push(ctx.ch_width);
            continue;
        }

        // auto column width calculation
        // if (firstcolumnlen === "auto") {
        //   firstcolumnlen = computeColWidthByContent(
        //     ctx.flowdata,
        //     c,
        //     rowCount
        //   );
        // }
        ctx.ch_width += Math.round(
            ((firstcolumnlen as number) + 1) * ctx.zoomRatio
        );

        ctx.visibledatacolumn.push(ctx.ch_width); // temporary column width distribution
    }

    ctx.ch_width += maxColumnlen;
}

export function ensureSheetIndex(data: Sheet[], generateSheetId: () => string) {
    if (data?.length > 0) {
        let hasActive = false;
        const indexs: (string | number)[] = [];
        data.forEach((item) => {
            if (item.id == null) {
                item.id = generateSheetId();
            }
            if (indexs.includes(item.id)) {
                item.id = generateSheetId();
            } else {
                indexs.push(item.id);
            }

            if (item.status == null) {
                item.status = 0;
            }
            if (item.status === 1) {
                if (hasActive) {
                    item.status = 0;
                } else {
                    hasActive = true;
                }
            }
        });
        if (!hasActive) {
            data[0].status = 1;
        }
    }
}

export function initSheetIndex(ctx: Context) {
    // get current sheet
    const shownSheets = ctx.luckysheetfile.filter(
        (singleSheet) => singleSheet.hide === undefined || singleSheet.hide !== 1
    );
    ctx.currentSheetId = sortBy(shownSheets, (sheet) => sheet.order)[0]
        .id as string;
    for (let i = 0; i < ctx.luckysheetfile.length; i += 1) {
        if (
            ctx.luckysheetfile[i].status === 1 &&
            ctx.luckysheetfile[i].hide !== 1
        ) {
            ctx.currentSheetId = ctx.luckysheetfile[i].id!;
            break;
        }
    }
}

export function updateContextWithSheetData(ctx: Context, data: any[][]) {
    const rowCount = data.length;
    const colCount = rowCount === 0 ? 0 : data[0].length;

    calcRowColSize(ctx, rowCount, colCount);
    normalizeSelection(ctx, ctx.luckysheet_select_save);
}

export function updateContextWithCanvas(
    ctx: Context,
    canvas: HTMLCanvasElement,
    placeholder: HTMLDivElement
) {
    ctx.luckysheetTableContentHW = [
        placeholder.clientWidth,
        placeholder.clientHeight,
    ];
    ctx.cellmainHeight = placeholder.clientHeight - ctx.columnHeaderHeight;
    ctx.cellmainWidth = placeholder.clientWidth - ctx.rowHeaderWidth;

    canvas.style.width = `${ctx.luckysheetTableContentHW[0]}px`;
    canvas.style.height = `${ctx.luckysheetTableContentHW[1]}px`;

    canvas.width = Math.ceil(
        ctx.luckysheetTableContentHW[0] * ctx.devicePixelRatio
    );
    canvas.height = Math.ceil(
        ctx.luckysheetTableContentHW[1] * ctx.devicePixelRatio
    );
}
