import numeral from 'numeral';
import { format, isDateFormat } from 'numfmt';
import { dateToSerial } from './parser/helper/number';
import type { Cell, CellMatrix, CellType } from './types';
import { ID_CARD_NUMBER, isdatetime, isPlainNumber, isRealNum, valueIsError } from './validation';

// Canonical display for a boolean cell — Excel's uppercase TRUE/FALSE. The xlsx
// importer shares it so literal booleans read the same as the formula-produced
// ones recalc pushes back through `update()`.
export function booleanDisplay(value: boolean): string {
    return value ? 'TRUE' : 'FALSE';
}

// Wrap breaks text only; the value decides too, since a formula typed into a text cell keeps its ct.t.
export function cellWrapsText(cell: Cell): boolean {
    return cell.tb === '2' && typeof cell.v !== 'number' && cell.ct?.t !== 'n' && cell.ct?.t !== 'd';
}

export function parseCellInput(value: string | number | boolean): [string, CellType, string | number | boolean] {
    const text = String(value);
    let m = '';
    let ct: CellType = {};
    let v: string | number | boolean = value;

    if (/^-?[0-9]{1,}[,][0-9]{3}(\.[0-9]{1,2})?$/.test(text)) {
        // String representing a monetary amount, e.g. 12,000.00 or -12,000.00
        m = text;
        v = Number(text.replace(',', ''));
        let fa = '#,##0';
        if (text.split('.')[1]) {
            fa = '#,##0.';
            for (let i = 0; i < text.split('.')[1].length; i += 1) {
                fa += '0';
            }
        }
        ct = { fa, t: 'n' };
    } else if (text.substring(0, 1) === "'") {
        m = text.substring(1);
        ct = { fa: '@', t: 's' };
    } else if (text.toUpperCase() === 'TRUE') {
        m = booleanDisplay(true);
        ct = { fa: 'General', t: 'b' };
        v = true;
    } else if (text.toUpperCase() === 'FALSE') {
        m = booleanDisplay(false);
        ct = { fa: 'General', t: 'b' };
        v = false;
    } else if (valueIsError(text)) {
        m = text;
        ct = { fa: 'General', t: 'e' };
    } else if (ID_CARD_NUMBER.test(text)) {
        m = text;
        ct = { fa: '@', t: 's' };
    } else if (
        isRealNum(value) &&
        Number.isFinite(parseFloat(text)) &&
        Math.abs(parseFloat(text)) > 0 &&
        (Math.abs(parseFloat(text)) >= 1e11 || Math.abs(parseFloat(text)) < 1e-9)
    ) {
        v = parseFloat(text);
        const str = v.toExponential();
        let fa: string;
        if (str.indexOf('.') > -1) {
            let strlen = str.split('.')[1].split('e')[0].length;
            if (strlen > 5) {
                strlen = 5;
            }

            fa = `#0.${new Array(strlen + 1).join('0')}E+00`;
        } else {
            fa = '#0.E+00';
        }

        ct = { fa, t: 'n' };
        m = format(fa, v);
    } else if (text.indexOf('%') > -1) {
        const index = text.indexOf('%');
        const value2 = text.substring(0, index);
        const value3 = value2.replace(/,/g, '');

        if (index === text.length - 1 && isRealNum(value3)) {
            if (value2.indexOf('.') > -1) {
                if (value2.indexOf('.') === value2.lastIndexOf('.')) {
                    const value4 = value2.split('.')[0];
                    const value5 = value2.split('.')[1];

                    let len = value5.length;
                    if (len > 9) {
                        len = 9;
                    }

                    if (value4.indexOf(',') > -1) {
                        let isThousands = true;
                        const ThousandsArr = value4.split(',');

                        for (let i = 1; i < ThousandsArr.length; i += 1) {
                            if (ThousandsArr[i].length < 3) {
                                isThousands = false;
                                break;
                            }
                        }

                        if (isThousands) {
                            const fa = `#,##0.${new Array(len + 1).join('0')}%`;
                            ct = { fa, t: 'n' };
                            v = numeral(value).value() ?? 0;
                            m = format(fa, v);
                        } else {
                            m = text;
                            ct = { fa: '@', t: 's' };
                        }
                    } else {
                        const fa = `0.${new Array(len + 1).join('0')}%`;
                        ct = { fa, t: 'n' };
                        v = numeral(value).value() ?? 0;
                        m = format(fa, v);
                    }
                } else {
                    m = text;
                    ct = { fa: '@', t: 's' };
                }
            } else if (value2.indexOf(',') > -1) {
                let isThousands = true;
                const ThousandsArr = value2.split(',');

                for (let i = 1; i < ThousandsArr.length; i += 1) {
                    if (ThousandsArr[i].length < 3) {
                        isThousands = false;
                        break;
                    }
                }

                if (isThousands) {
                    const fa = '#,##0%';
                    ct = { fa, t: 'n' };
                    v = numeral(value).value() ?? 0;
                    m = format(fa, v);
                } else {
                    m = text;
                    ct = { fa: '@', t: 's' };
                }
            } else {
                const fa = '0%';
                ct = { fa, t: 'n' };
                v = numeral(value).value() ?? 0;
                m = format(fa, v);
            }
        } else {
            m = text;
            ct = { fa: '@', t: 's' };
        }
    } else if (text.indexOf('.') > -1) {
        if (text.indexOf('.') === text.lastIndexOf('.')) {
            const value1 = text.split('.')[0];
            const value2 = text.split('.')[1];

            let len = value2.length;
            if (len > 9) {
                len = 9;
            }

            if (value1.indexOf(',') > -1) {
                let isThousands = true;
                const ThousandsArr = value1.split(',');

                for (let i = 1; i < ThousandsArr.length; i += 1) {
                    if (!isRealNum(ThousandsArr[i]) || ThousandsArr[i].length < 3) {
                        isThousands = false;
                        break;
                    }
                }

                if (isThousands) {
                    const fa = `#,##0.${new Array(len + 1).join('0')}`;
                    ct = { fa, t: 'n' };
                    v = numeral(value).value() ?? 0;
                    m = format(fa, v);
                } else {
                    m = text;
                    ct = { fa: '@', t: 's' };
                }
            } else {
                if (isRealNum(value1) && isRealNum(value2)) {
                    const fa = `0.${new Array(len + 1).join('0')}`;
                    ct = { fa, t: 'n' };
                    v = numeral(value).value() ?? 0;
                    m = format(fa, v);
                } else {
                    m = text;
                    ct = { fa: '@', t: 's' };
                }
            }
        } else {
            m = text;
            ct = { fa: '@', t: 's' };
        }
    } else if (isPlainNumber(value)) {
        v = parseFloat(text);
        m = numberDisplay(v);
        ct = { fa: 'General', t: 'n' };
    } else if (isdatetime(value, '24') && (text.indexOf('.') > -1 || text.indexOf(':') > -1 || text.length < 16)) {
        v = dateToSerial(new Date(text.replace(/-/g, '/')));

        let fa: string;
        if (v.toString().indexOf('.') > -1) {
            if (text.length > 18) {
                fa = 'yyyy-MM-dd hh:mm:ss';
            } else if (text.length > 11) {
                fa = 'yyyy-MM-dd hh:mm';
            } else {
                fa = 'yyyy-MM-dd';
            }
        } else {
            fa = 'yyyy-MM-dd';
        }

        ct = { fa, t: 'd' };
        m = format(fa, v);
    } else if (isdatetime(value, '12') && (text.indexOf('.') > -1 || text.indexOf(':') > -1 || text.length < 20)) {
        v = dateToSerial(
            new Date(
                text
                    .replace(/-/g, '/')
                    .replace(/(AM|PM)/gi, ' $1')
                    .replace(/ {2,}/g, ' '),
            ),
        );

        let fa: string;
        if (v.toString().indexOf('.') > -1) {
            if (text.length > 20) {
                fa = 'yyyy-MM-dd hh:mm:ss AM/PM';
            } else if (text.length > 13) {
                fa = 'yyyy-MM-dd hh:mm AM/PM';
            } else {
                fa = 'yyyy-MM-dd';
            }
        } else {
            fa = 'yyyy-MM-dd';
        }

        ct = { fa, t: 'd' };
        m = format(fa, v);
    } else {
        m = text;
        ct = { fa: 'General', t: 'g' };
    }

    return [m, ct, v];
}

export function update(fmt: string, v: string | number | boolean | null | undefined): string {
    return format(fmt, v);
}

// Every writer's display string for a cell value; General is Excel's default-width General (1.23457E+11).
export function numberDisplay(value: Cell['v'] | null, fa = 'General'): string {
    if (typeof value === 'number' && !Number.isFinite(value)) return value.toString();
    try {
        return update(fa, value);
    } catch {
        // numfmt throws on a malformed format, which an xlsx numFmt can carry into ct.fa.
        return update('General', value);
    }
}

export function is_date(fmt: number | string): boolean {
    if (typeof fmt !== 'string') return false;
    return isDateFormat(fmt);
}

function fuzzynum(s: string | number | boolean) {
    let v = Number(s);
    if (typeof s === 'number') {
        return s;
    }
    if (typeof s === 'boolean') {
        return s ? 1 : 0;
    }
    if (!Number.isNaN(v)) return v;
    let wt = 1;
    let ss = s
        .replace(/([\d]),([\d])/g, '$1$2')
        .replace(/[$]/g, '')
        .replace(/[%]/g, () => {
            wt *= 100;
            return '';
        });
    v = Number(ss);
    if (!Number.isNaN(v)) return v / wt;
    ss = ss.replace(/[(](.*)[)]/, (_match, inner: string) => {
        wt = -wt;
        return inner;
    });
    v = Number(ss);
    if (!Number.isNaN(v)) return v / wt;
    return v;
}

function cellAttr(d: CellMatrix, r: number, c: number, attr: 'm' | 'v'): string | number | boolean | null {
    const cell = d[r]?.[c];
    if (cell == null || typeof cell !== 'object') return null;
    // Date cells always return the display string (m)
    if (cell.ct?.t === 'd') return cell.m ?? null;
    return cell[attr] ?? null;
}

export function valueShowEs(r: number, c: number, d: CellMatrix) {
    const m = cellAttr(d, r, c, 'm');
    if (m == null) {
        return cellAttr(d, r, c, 'v');
    }

    if (!Number.isNaN(fuzzynum(m))) {
        // Numeric-looking display string: keep the display only for percent strings,
        // otherwise prefer the raw value.
        const isPercentString = typeof m === 'string' && m.indexOf('%') > -1;
        return isPercentString ? m : cellAttr(d, r, c, 'v');
    }

    // Non-numeric display string: keep it for date/boolean cells, else fall back to raw value.
    const cellType = d[r]?.[c]?.ct?.t;
    if (cellType === 'd' || cellType === 'b') {
        return m;
    }
    return cellAttr(d, r, c, 'v');
}
