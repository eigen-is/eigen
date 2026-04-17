import dayjs from "dayjs";
import _ from "lodash";
import {Context} from "../context";
import {hasChinaword} from "./text";

export { error, valueIsError, isRealNull, isRealNum, isdatetime } from "../../engine/validation";
import { isdatetime } from "../../engine/validation";

export function diff(now: any, then: any) {
    return dayjs(now).diff(dayjs(then));
}

export function isdatatypemulti(s: any) {
    const type: any = {};

    if (isdatetime(s)) {
        type.date = true;
    }

    if (!Number.isNaN(parseFloat(s)) && !hasChinaword(s)) {
        type.num = true;
    }

    return type;
}

export function isdatatype(s: any) {
    let type = "string";

    if (isdatetime(s)) {
        type = "date";
    } else if (!Number.isNaN(parseFloat(s)) && !hasChinaword(s)) {
        type = "num";
    }

    return type;
}

// Whether the range contains only part of a merged cell
export function hasPartMC(
    ctx: Context,
    cfg: any,
    r1: number,
    r2: number,
    c1: number,
    c2: number
) {
    let ret = false;

    _.forEach(ctx.config.merge, (mc) => {
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
