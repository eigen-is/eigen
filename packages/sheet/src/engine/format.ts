import numeral from 'numeral';
import { format, isDateFormat } from 'numfmt';
import type { CellMatrix, CellType } from './types';
import { isdatetime, isRealNum, valueIsError } from './validation';

const base1904 = new Date(1900, 2, 1, 0, 0, 0);

export function datenum_local(v: Date, date1904?: number) {
    let epoch = Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds());
    const dnthresh_utc = Date.UTC(1899, 11, 31, 0, 0, 0);

    if (date1904) epoch -= 1461 * 24 * 60 * 60 * 1000;
    else if (v >= base1904) epoch += 24 * 60 * 60 * 1000;
    return (epoch - dnthresh_utc) / (24 * 60 * 60 * 1000);
}

let good_pd_date = new Date('2017-02-19T19:06:09.000Z');
if (Number.isNaN(good_pd_date.getFullYear())) good_pd_date = new Date('2/19/17');
const good_pd = good_pd_date.getFullYear() === 2017;

/* parses a date as a local date */
function parseDate(str: string | Date, fixdate?: number) {
    const d = new Date(str);
    if (good_pd) {
        if (fixdate != null) {
            if (fixdate > 0) d.setTime(d.getTime() + d.getTimezoneOffset() * 60 * 1000);
            else if (fixdate < 0) d.setTime(d.getTime() - d.getTimezoneOffset() * 60 * 1000);
        }
        return d;
    }
    if (str instanceof Date) return str;
    if (good_pd_date.getFullYear() === 1917 && !Number.isNaN(d.getFullYear())) {
        const s = d.getFullYear();
        if (str.indexOf(`${s}`) > -1) return d;
        d.setFullYear(d.getFullYear() + 100);
        return d;
    }
    const n = str.match(/\d+/g) || ['2017', '2', '19', '0', '0', '0'];
    let out = new Date(+n[0], +n[1] - 1, +n[2], +n[3] || 0, +n[4] || 0, +n[5] || 0);
    if (str.indexOf('Z') > -1) out = new Date(out.getTime() - out.getTimezoneOffset() * 60 * 1000);
    return out;
}

// Canonical display for a boolean cell — Excel's uppercase TRUE/FALSE. The xlsx
// importer shares it so literal booleans read the same as the formula-produced
// ones recalc pushes back through `update()`.
export function booleanDisplay(value: boolean): string {
    return value ? 'TRUE' : 'FALSE';
}

export function genarate(value: string | number | boolean): [string, CellType, string | number | boolean] {
    let m = '';
    let ct: CellType = {};
    let v: string | number | boolean = value;

    if (/^-?[0-9]{1,}[,][0-9]{3}(.[0-9]{1,2})?$/.test(value as string)) {
        value = value as string;
        // String representing a monetary amount, e.g. 12,000.00 or -12,000.00
        m = value;
        v = Number(value.split('.')[0].replace(',', ''));
        let fa = '#,##0';
        if (value.split('.')[1]) {
            fa = '#,##0.';
            for (let i = 0; i < value.split('.')[1].length; i += 1) {
                fa += 0;
            }
        }
        ct = { fa, t: 'n' };
    } else if (value.toString().substring(0, 1) === "'") {
        m = value.toString().substring(1);
        ct = { fa: '@', t: 's' };
    } else if (value.toString().toUpperCase() === 'TRUE') {
        m = booleanDisplay(true);
        ct = { fa: 'General', t: 'b' };
        v = true;
    } else if (value.toString().toUpperCase() === 'FALSE') {
        m = booleanDisplay(false);
        ct = { fa: 'General', t: 'b' };
        v = false;
    } else if (valueIsError(value.toString())) {
        m = value.toString();
        ct = { fa: 'General', t: 'e' };
    } else if (/^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i.test(value as string)) {
        m = value.toString();
        ct = { fa: '@', t: 's' };
    } else if (
        isRealNum(value) &&
        Math.abs(parseFloat(value as string)) > 0 &&
        (Math.abs(parseFloat(value as string)) >= 1e11 || Math.abs(parseFloat(value as string)) < 1e-9)
    ) {
        v = parseFloat(value as string);
        const str = v.toExponential();
        if (str.indexOf('.') > -1) {
            let strlen = str.split('.')[1].split('e')[0].length;
            if (strlen > 5) {
                strlen = 5;
            }

            ct = { fa: `#0.${new Array(strlen + 1).join('0')}E+00`, t: 'n' };
        } else {
            ct = { fa: '#0.E+00', t: 'n' };
        }

        m = format(ct.fa!, v);
    } else if (value.toString().indexOf('%') > -1) {
        const index = value.toString().indexOf('%');
        const value2 = value.toString().substring(0, index);
        const value3 = value2.replace(/,/g, '');

        if (index === value.toString().length - 1 && isRealNum(value3)) {
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
                            ct = {
                                fa: `#,##0.${new Array(len + 1).join('0')}%`,
                                t: 'n',
                            };
                            v = numeral(value).value() ?? 0;
                            m = format(ct.fa!, v);
                        } else {
                            m = value.toString();
                            ct = { fa: '@', t: 's' };
                        }
                    } else {
                        ct = { fa: `0.${new Array(len + 1).join('0')}%`, t: 'n' };
                        v = numeral(value).value() ?? 0;
                        m = format(ct.fa!, v);
                    }
                } else {
                    m = value.toString();
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
                    ct = { fa: '#,##0%', t: 'n' };
                    v = numeral(value).value() ?? 0;
                    m = format(ct.fa!, v);
                } else {
                    m = value.toString();
                    ct = { fa: '@', t: 's' };
                }
            } else {
                ct = { fa: '0%', t: 'n' };
                v = numeral(value).value() ?? 0;
                m = format(ct.fa!, v);
            }
        } else {
            m = value.toString();
            ct = { fa: '@', t: 's' };
        }
    } else if (value.toString().indexOf('.') > -1) {
        if (value.toString().indexOf('.') === value.toString().lastIndexOf('.')) {
            const value1 = value.toString().split('.')[0];
            const value2 = value.toString().split('.')[1];

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
                    ct = { fa: `#,##0.${new Array(len + 1).join('0')}`, t: 'n' };
                    v = numeral(value).value() ?? 0;
                    m = format(ct.fa!, v);
                } else {
                    m = value.toString();
                    ct = { fa: '@', t: 's' };
                }
            } else {
                if (isRealNum(value1) && isRealNum(value2)) {
                    ct = { fa: `0.${new Array(len + 1).join('0')}`, t: 'n' };
                    v = numeral(value).value() ?? 0;
                    m = format(ct.fa!, v);
                } else {
                    m = value.toString();
                    ct = { fa: '@', t: 's' };
                }
            }
        } else {
            m = value.toString();
            ct = { fa: '@', t: 's' };
        }
    } else if (isRealNum(value)) {
        m = parseFloat(value as string).toString();
        ct = { fa: 'General', t: 'n' };
        v = parseFloat(value as string);
    } else if (
        isdatetime(value, '24') &&
        (value.toString().indexOf('.') > -1 || value.toString().indexOf(':') > -1 || value.toString().length < 16)
    ) {
        v = datenum_local(parseDate(value.toString().replace(/-/g, '/')));

        if (v.toString().indexOf('.') > -1) {
            if (value.toString().length > 18) {
                ct.fa = 'yyyy-MM-dd hh:mm:ss';
            } else if (value.toString().length > 11) {
                ct.fa = 'yyyy-MM-dd hh:mm';
            } else {
                ct.fa = 'yyyy-MM-dd';
            }
        } else {
            ct.fa = 'yyyy-MM-dd';
        }

        ct.t = 'd';
        m = format(ct.fa!, v);
    } else if (
        isdatetime(value, '12') &&
        (value.toString().indexOf('.') > -1 || value.toString().indexOf(':') > -1 || value.toString().length < 20)
    ) {
        v = datenum_local(
            parseDate(
                value
                    .toString()
                    .replace(/-/g, '/')
                    .replace(/(AM|PM)/gi, ' $1')
                    .replace(/ {2,}/g, ' '),
            ),
        );

        if (v.toString().indexOf('.') > -1) {
            if (value.toString().length > 20) {
                ct.fa = 'yyyy-MM-dd hh:mm:ss AM/PM';
            } else if (value.toString().length > 13) {
                ct.fa = 'yyyy-MM-dd hh:mm AM/PM';
            } else {
                ct.fa = 'yyyy-MM-dd';
            }
        } else {
            ct.fa = 'yyyy-MM-dd';
        }

        ct.t = 'd';
        m = format(ct.fa!, v);
    } else {
        m = value as string;
        ct.fa = 'General';
        ct.t = 'g';
    }

    return [m, ct, v];
}

export function update(fmt: string, v: string | number | boolean | null | undefined): string {
    return format(fmt, v);
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
