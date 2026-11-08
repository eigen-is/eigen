// What kind of value a cell holds, for the editor's modules: the engine's checks re-exported, the difference between
// two dates and whether a range cuts a merge. Sort and the data-validation dialog are examples of who asks.

import dayjs from 'dayjs';
import { forEach } from 'es-toolkit/compat';
import type { Context } from '../context';
import { getSheetConfig } from '../context';

export {
    error,
    ID_CARD_NUMBER,
    isdatetime,
    isPlainNumber,
    isRealNull,
    isRealNum,
    valueIsError,
} from '../../engine/validation';

export function diff(now: dayjs.ConfigType, then: dayjs.ConfigType) {
    return dayjs(now).diff(dayjs(then));
}

export const PART_MERGE_REFUSAL = 'Cannot perform this operation on merged cells';

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
