import dayjs from 'dayjs';
import { forEach } from 'es-toolkit/compat';
import { type Context, getSheetConfig } from '../context';
import { hasChinaword } from './text';

export { error, isdatetime, isRealNull, isRealNum, valueIsError } from '../../engine/validation';

export function diff(now: dayjs.ConfigType, then: dayjs.ConfigType) {
    return dayjs(now).diff(dayjs(then));
}

export function isdatatypemulti(s: unknown) {
    const str = String(s);
    return !Number.isNaN(parseFloat(str)) && !hasChinaword(str);
}

// Whether the range contains only part of a merged cell.
export function hasPartMC(ctx: Context, r1: number, r2: number, c1: number, c2: number) {
    let ret = false;

    forEach(getSheetConfig(ctx)?.merge, (mc) => {
        if (r1 < mc.r) {
            if (r2 >= mc.r && r2 < mc.r + mc.rs - 1) {
                if (c1 >= mc.c && c1 <= mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c2 >= mc.c && c2 <= mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c1 < mc.c && c2 > mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
            } else if (r2 >= mc.r && r2 === mc.r + mc.rs - 1) {
                if (c1 > mc.c && c1 < mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c2 > mc.c && c2 < mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c1 === mc.c && c2 < mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c1 > mc.c && c2 === mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
            } else if (r2 > mc.r + mc.rs - 1) {
                if (c1 > mc.c && c1 <= mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c2 >= mc.c && c2 < mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c1 === mc.c && c2 < mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c1 > mc.c && c2 === mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
            }
        } else if (r1 === mc.r) {
            if (r2 < mc.r + mc.rs - 1) {
                if (c1 >= mc.c && c1 <= mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c2 >= mc.c && c2 <= mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c1 < mc.c && c2 > mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
            } else if (r2 >= mc.r + mc.rs - 1) {
                if (c1 > mc.c && c1 <= mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c2 >= mc.c && c2 < mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c1 === mc.c && c2 < mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
                if (c1 > mc.c && c2 === mc.c + mc.cs - 1) {
                    ret = true;
                    return false;
                }
            }
        } else if (r1 <= mc.r + mc.rs - 1) {
            if (c1 >= mc.c && c1 <= mc.c + mc.cs - 1) {
                ret = true;
                return false;
            }
            if (c2 >= mc.c && c2 <= mc.c + mc.cs - 1) {
                ret = true;
                return false;
            }
            if (c1 < mc.c && c2 > mc.c + mc.cs - 1) {
                ret = true;
                return false;
            }
        }
        return true;
    });

    return ret;
}
