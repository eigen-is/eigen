import * as _ from "es-toolkit/compat";
import type {Context} from "../context";
import {escapeHTMLTag, escapeScriptTag} from "../utils";
import {locale} from "../locale";
import {cancelFunctionrangeSelected} from ".";
import {
    colors,
    formulaUIState,
    iscelldata,
    operatorjson,
    resetFunctionHTMLIndex,
    resetRangeIndexes,
    setFunctionHTMLIndex,
    setRangeIndexes,
} from "./formula-ui";
import {createRangeHightlight, setCaretPosition} from "./formula-range";

function functionHTML(txt: string) {
    if (txt.substr(0, 1) === "=") {
        txt = txt.substr(1);
    }

    const funcstack = txt.split("");
    let i = 0;
    let str = "";
    let function_str = "";
    const matchConfig = {
        bracket: 0,
        comma: 0,
        squote: 0,
        dquote: 0,
        braces: 0,
    };

    while (i < funcstack.length) {
        const s = funcstack[i];

        if (
            s === "(" &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            matchConfig.bracket += 1;

            if (str.length > 0) {
                function_str += `<span dir="auto" class="luckysheet-formula-text-func">${str}</span><span dir="auto" class="luckysheet-formula-text-lpar">(</span>`;
            } else {
                function_str +=
                    '<span dir="auto" class="luckysheet-formula-text-lpar">(</span>';
            }

            str = "";
        } else if (
            s === ")" &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            matchConfig.bracket -= 1;
            function_str += `${functionHTML(
                str
            )}<span dir="auto" class="luckysheet-formula-text-rpar">)</span>`;
            str = "";
        } else if (
            s === "{" &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0
        ) {
            str += "{";
            matchConfig.braces += 1;
        } else if (
            s === "}" &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0
        ) {
            str += "}";
            matchConfig.braces -= 1;
        } else if (s === '"' && matchConfig.squote === 0) {
            if (matchConfig.dquote > 0) {
                if (str.length > 0) {
                    function_str += `${str}"</span>`;
                } else {
                    function_str += '"</span>';
                }

                matchConfig.dquote -= 1;
                str = "";
            } else {
                matchConfig.dquote += 1;

                if (str.length > 0) {
                    function_str += `${functionHTML(
                        str
                    )}<span dir="auto" class="luckysheet-formula-text-string">"`;
                } else {
                    function_str +=
                        '<span dir="auto" class="luckysheet-formula-text-string">"';
                }

                str = "";
            }
        }
        // Fix the issue where entering a formula like ='1-2'!A1 causes only 2'!A1 to be colored as fortune-formula-functionrange-cell, while '1- remains black.
        else if (s === "'" && matchConfig.dquote === 0) {
            str += "'";
            matchConfig.squote = matchConfig.squote === 0 ? 1 : 0;
        } else if (
            s === "," &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            // matchConfig.comma += 1;
            function_str += `${functionHTML(
                str
            )}<span dir="auto" class="luckysheet-formula-text-comma">,</span>`;
            str = "";
        } else if (
            s === "&" &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            if (str.length > 0) {
                function_str +=
                    `${functionHTML(
                        str
                    )}<span dir="auto" class="luckysheet-formula-text-calc">` +
                    `&` +
                    `</span>`;
                str = "";
            } else {
                function_str +=
                    '<span dir="auto" class="luckysheet-formula-text-calc">' +
                    "&" +
                    "</span>";
            }
        } else if (
            s in operatorjson &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            let s_next = "";
            if (i + 1 < funcstack.length) {
                s_next = funcstack[i + 1];
            }

            let p = i - 1;
            let s_pre = null;
            if (p >= 0) {
                do {
                    s_pre = funcstack[p];
                    p -= 1;
                } while (p >= 0 && s_pre === " ");
            }

            if (s + s_next in operatorjson) {
                if (str.length > 0) {
                    function_str += `${functionHTML(
                        str
                    )}<span dir="auto" class="luckysheet-formula-text-calc">${s}${s_next}</span>`;
                    str = "";
                } else {
                    function_str += `<span dir="auto" class="luckysheet-formula-text-calc">${s}${s_next}</span>`;
                }

                i += 1;
            } else if (
                !/[^0-9]/.test(s_next) &&
                s === "-" &&
                (s_pre === "(" ||
                    _.isNil(s_pre) ||
                    s_pre === "," ||
                    s_pre === " " ||
                    s_pre in operatorjson)
            ) {
                str += s;
            } else {
                if (str.length > 0) {
                    function_str += `${functionHTML(
                        str
                    )}<span dir="auto" class="luckysheet-formula-text-calc">${s}</span>`;
                    str = "";
                } else {
                    function_str += `<span dir="auto" class="luckysheet-formula-text-calc">${s}</span>`;
                }
            }
        } else {
            str += s;
        }

        if (i === funcstack.length - 1) {
            // function_str += str;
            if (iscelldata(_.trim(str))) {
                const rangeIndex =
                    formulaUIState.rangeIndexes.length > formulaUIState.functionHTMLIndex
                        ? formulaUIState.rangeIndexes[formulaUIState.functionHTMLIndex]
                        : formulaUIState.functionHTMLIndex;
                function_str += `<span class="fortune-formula-functionrange-cell" rangeindex="${rangeIndex}" dir="auto" style="color:${colors[rangeIndex]};">${str}</span>`;
                setFunctionHTMLIndex(formulaUIState.functionHTMLIndex + 1);
            } else if (matchConfig.dquote > 0) {
                function_str += `${str}</span>`;
            } else if (str.indexOf("</span>") === -1 && str.length > 0) {
                const regx = /{.*?}/;

                if (regx.test(_.trim(str))) {
                    const arraytxt = regx.exec(str)![0];
                    const arraystart = str.search(regx);
                    let alltxt = "";

                    if (arraystart > 0) {
                        alltxt += `<span dir="auto" class="luckysheet-formula-text-color">${str.substr(
                            0,
                            arraystart
                        )}</span>`;
                    }

                    alltxt += `<span dir="auto" style="color:#959a05" class="luckysheet-formula-text-array">${arraytxt}</span>`;

                    if (arraystart + arraytxt.length < str.length) {
                        alltxt += `<span dir="auto" class="luckysheet-formula-text-color">${str.substr(
                            arraystart + arraytxt.length,
                            str.length
                        )}</span>`;
                    }

                    function_str += alltxt;
                } else {
                    function_str += `<span dir="auto" class="luckysheet-formula-text-color">${str}</span>`;
                }
            }
        }

        i += 1;
    }

    return function_str;
}

export function functionHTMLGenerate(txt: string) {
    if (txt.length === 0 || txt.substring(0, 1) !== "=") {
        return txt;
    }

    resetFunctionHTMLIndex();

    return `<span dir="auto" class="luckysheet-formula-text-color">=</span>${functionHTML(
        txt
    )}`;
}

function getRangeIndexes($editor: HTMLDivElement) {
    const res: number[] = [];
    $editor
        .querySelectorAll("span.fortune-formula-functionrange-cell")
        .forEach((ele) => {
            const indexStr = ele.getAttribute("rangeindex");
            if (indexStr) {
                const rangeIndex = parseInt(indexStr, 10);
                res.push(rangeIndex);
            }
        });
    return res;
}

function searchFunction(ctx: Context, searchtxt: string) {
    const {functionlist} = locale(ctx);

    // // This logic has been modified from the original project
    // if (_.isNil($editer)) {
    //   return;
    // }
    // const inputContent = $editer.innerText.toUpperCase();
    // const reg = /^=([a-zA-Z_]+)\(?/;
    // const match = inputContent.match(reg);
    // if (!match) {
    //   ctx.functionCandidates = [];
    //   return;
    // }

    // const searchtxt = match[1];

    const f: typeof functionlist = [];
    const s: typeof functionlist = [];
    const t: typeof functionlist = [];
    let result_i = 0;

    for (let i = 0; i < functionlist.length; i += 1) {
        const item = functionlist[i];
        const {n} = item;

        if (n === searchtxt) {
            f.unshift(item);
            result_i += 1;
        } else if (_.startsWith(n, searchtxt)) {
            s.unshift(item);
            result_i += 1;
        } else if (n.indexOf(searchtxt) > -1) {
            t.unshift(item);
            result_i += 1;
        }

        if (result_i >= 10) {
            break;
        }
    }

    const list = [...f, ...s, ...t];
    if (list.length <= 0) {
        return;
    }

    ctx.functionCandidates = list;
}

export function getrangeseleciton() {
    const currSelection = window.getSelection();
    if (!currSelection) return null;
    const {anchorNode, anchorOffset} = currSelection;

    if (!anchorNode) return null;

    if (
        anchorNode.parentNode?.nodeName?.toLowerCase() === "span" &&
        anchorOffset !== 0
    ) {
        let txt = _.trim(anchorNode.textContent || "");
        if (txt.length === 0 && anchorNode.parentNode.previousSibling) {
            const ahr = anchorNode.parentNode.previousSibling;
            txt = _.trim(ahr.textContent || "");
            return ahr;
        }
        return anchorNode.parentNode;
    }
    const anchorElement = anchorNode as HTMLElement;
    if (
        anchorElement.id === "luckysheet-rich-text-editor" ||
        anchorElement.id === "luckysheet-functionbox-cell"
    ) {
        let txt = _.trim(_.last(anchorElement.querySelectorAll("span"))?.innerText);

        if (txt.length === 0 && anchorElement.querySelectorAll("span").length > 1) {
            const ahr = anchorElement.querySelectorAll("span");
            txt = _.trim(ahr[ahr.length - 2].innerText);
            return ahr?.[0];
        }
        return _.last(anchorElement.querySelectorAll("span"));
    }
    if (
        anchorNode?.parentElement?.id === "luckysheet-rich-text-editor" ||
        anchorNode?.parentElement?.id === "luckysheet-functionbox-cell" ||
        anchorOffset === 0
    ) {
        const newAnchorNode =
            anchorOffset === 0 ? anchorNode?.parentNode : anchorNode;

        if (newAnchorNode?.previousSibling) {
            return newAnchorNode?.previousSibling;
        }
    }

    return null;
}

function helpFunctionExe(
    $editer: HTMLDivElement,
    currSelection: Node,
    ctx: Context
) {
    const {functionlist} = locale(ctx);
    if (_.isEmpty(ctx.formulaCache.functionlistMap)) {
        for (let i = 0; i < functionlist.length; i += 1) {
            ctx.formulaCache.functionlistMap[functionlist[i].n] = functionlist[i];
        }
    }
    if (!currSelection) {
        return null;
    }

    const $prev = currSelection;
    const $span = $editer.querySelectorAll("span");
    const currentIndex = _.indexOf(
        currSelection.parentNode?.childNodes,
        currSelection
    );
    let i = currentIndex;

    if ($prev == null) {
        return null;
    }

    let funcName = null;
    let paramindex = null;

    if ($span[i].classList.contains("luckysheet-formula-text-func")) {
        funcName = $span[i].textContent;
    } else {
        let $cur = null;
        let exceptIndex = [-1, -1];

        // eslint-disable-next-line no-plusplus
        while (--i > 0) {
            $cur = $span[i];

            if (
                $cur.classList.contains("luckysheet-formula-text-func") ||
                _.trim($cur.textContent || "").toUpperCase() in
                ctx.formulaCache.functionlistMap
            ) {
                funcName = $cur.textContent;
                paramindex = null;
                let endstate = true;

                for (let a = i; a <= currentIndex; a += 1) {
                    if (!paramindex) {
                        paramindex = 0;
                    }

                    if (a >= exceptIndex[0] && a <= exceptIndex[1]) {
                        continue;
                    }

                    $cur = $span[a];
                    if ($cur.classList.contains("luckysheet-formula-text-rpar")) {
                        exceptIndex = [i, a];
                        funcName = null;
                        endstate = false;
                        break;
                    }

                    if ($cur.classList.contains("luckysheet-formula-text-comma")) {
                        paramindex += 1;
                    }
                }

                if (endstate) {
                    break;
                }
            }
        }
    }

    return funcName;
}

export function rangeHightlightselected(ctx: Context, $editor: HTMLDivElement) {
    const currSelection = getrangeseleciton();
    if (!currSelection) return;

    const currText = _.trim(currSelection.textContent || "");
    if (currText?.match(/^[a-zA-Z_]+$/)) {
        searchFunction(ctx, currText.toUpperCase());
        ctx.functionHint = null;
    } else {
        const funcName = helpFunctionExe($editor, currSelection, ctx);
        ctx.functionHint = funcName?.toUpperCase();
        ctx.functionCandidates = [];
    }
}

export function israngeseleciton(ctx: Context, istooltip?: boolean) {
    if (istooltip == null) {
        istooltip = false;
    }

    const currSelection = window.getSelection();
    if (currSelection == null) return false;
    let anchor = currSelection.anchorNode;
    if (!anchor?.textContent) return false;
    const {anchorOffset} = currSelection;
    const anchorElement = anchor as HTMLElement;
    const parentElement = anchor.parentNode as HTMLElement;
    if (
        anchor?.parentNode?.nodeName.toLowerCase() === "span" &&
        anchorOffset !== 0
    ) {
        let txt = _.trim(anchor.textContent);
        let lasttxt = "";

        if (txt.length === 0 && anchor.parentNode.previousSibling) {
            const ahr = anchor.parentNode.previousSibling;
            txt = _.trim(ahr.textContent || "");
            lasttxt = txt.substring(txt.length - 1, 1);
            ctx.formulaCache.rangeSetValueTo = anchor.parentNode;
        } else {
            lasttxt = txt.substring(anchorOffset - 1, 1);
            ctx.formulaCache.rangeSetValueTo = anchor.parentNode;
        }

        if (
            (istooltip && (lasttxt === "(" || lasttxt === ",")) ||
            (!istooltip &&
                (lasttxt === "(" ||
                    lasttxt === "," ||
                    lasttxt === "=" ||
                    lasttxt in operatorjson ||
                    lasttxt === "&"))
        ) {
            return true;
        }
    } else if (
        anchorElement.id === "luckysheet-rich-text-editor" ||
        anchorElement.id === "luckysheet-functionbox-cell"
    ) {
        let txt = _.trim(_.last(anchorElement.querySelectorAll("span"))?.innerText);

        ctx.formulaCache.rangeSetValueTo = _.last(
            anchorElement.querySelectorAll("span")
        );

        if (txt.length === 0 && anchorElement.querySelectorAll("span").length > 1) {
            const ahr = anchorElement.querySelectorAll("span");
            txt = _.trim(ahr[ahr.length - 2].innerText);

            txt = _.trim(ahr[ahr.length - 2].innerText);
            ctx.formulaCache.rangeSetValueTo = ahr;
        }

        const lasttxt = txt.substring(txt.length - 1, 1);

        if (
            (istooltip && (lasttxt === "(" || lasttxt === ",")) ||
            (!istooltip &&
                (lasttxt === "(" ||
                    lasttxt === "," ||
                    lasttxt === "=" ||
                    lasttxt in operatorjson ||
                    lasttxt === "&"))
        ) {
            return true;
        }
    } else if (
        parentElement.id === "luckysheet-rich-text-editor" ||
        parentElement.id === "luckysheet-functionbox-cell" ||
        anchorOffset === 0
    ) {
        if (anchorOffset === 0) {
            anchor = anchor.parentNode;
        }
        if (!anchor) return false;
        if (anchor.previousSibling?.textContent == null) return false;
        if (anchor.previousSibling) {
            const txt = _.trim(anchor.previousSibling.textContent);
            const lasttxt = txt.substring(txt.length - 1, 1);

            ctx.formulaCache.rangeSetValueTo = anchor.previousSibling;

            if (
                (istooltip && (lasttxt === "(" || lasttxt === ",")) ||
                (!istooltip &&
                    (lasttxt === "(" ||
                        lasttxt === "," ||
                        lasttxt === "=" ||
                        lasttxt in operatorjson ||
                        lasttxt === "&"))
            ) {
                return true;
            }
        }
    }

    return false;
}

function functionRange(
    ctx: Context,
    obj: HTMLDivElement,
    v: string,
    vp: string
) {
    if (window.getSelection) {
        // ie11 10 9 ff safari
        const currSelection = window.getSelection();
        if (!currSelection) return;
        const fri = findrangeindex(ctx, v, vp);

        if (_.isNil(fri)) {
            currSelection.selectAllChildren(obj);
            currSelection.collapseToEnd();
        } else {
            setCaretPosition(ctx, obj.querySelectorAll("span")[fri[0]], 0, fri[1]);
        }
        // @ts-ignore
    } else if (document.selection) {
        // ie10 9 8 7 6 5
        // @ts-ignore
        ctx.formulaCache.functionRangeIndex.moveToElementText(obj); // move range to obj
        // @ts-ignore
        ctx.formulaCache.functionRangeIndex.collapse(false); // move cursor to end
        // @ts-ignore
        ctx.formulaCache.functionRangeIndex.select();
    }
}

function findrangeindex(ctx: Context, v: string, vp: string) {
    const re = /<span.*?>/g;
    const v_a = v.replace(re, "").split("</span>");
    const vp_a = vp.replace(re, "").split("</span>");
    v_a.pop();
    if (vp_a[vp_a.length - 1] === "") vp_a.pop();

    let pfri = ctx.formulaCache.functionRangeIndex;
    if (pfri == null) return [];

    const vplen = vp_a.length;
    const vlen = v_a.length;
    // No element added to input
    if (vplen === vlen) {
        const i = pfri[0];
        const p = vp_a[i];
        const n = v_a[i];

        if (_.isNil(p)) {
            if (vp_a.length <= i) {
                pfri = [vp_a.length - 1, vp_a.length - 1];
            } else if (v_a.length <= i) {
                pfri = [v_a.length - 1, v_a.length - 1];
            }

            return pfri;
        }
        if (p.length === n.length) {
            if (
                !_.isNil(vp_a[i + 1]) &&
                !_.isNil(v_a[i + 1]) &&
                vp_a[i + 1].length < v_a[i + 1].length
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            }

            return pfri;
        }
        if (p.length > n.length) {
            if (
                !_.isNil(p) &&
                !_.isNil(v_a[i + 1]) &&
                v_a[i + 1].substring(0, 1) === '"' &&
                (p.indexOf("{") > -1 || p.indexOf("}") > -1)
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            }

            return pfri;
        }
        if (p.length < n.length) {
            if (pfri[1] > n.length) {
                pfri[1] = n.length;
            }

            return pfri;
        }
    }
    // Element removed from input
    else if (vplen > vlen) {
        const i = pfri[0];
        const p = vp_a[i];
        const n = v_a[i];

        if (_.isNil(n)) {
            if (v_a[i - 1].indexOf("{") > -1) {
                pfri[0] -= 1;
                const start = v_a[i - 1].search("{");
                pfri[1] += start;
            } else {
                pfri[0] = 0;
                pfri[1] = 0;
            }
        } else if (p.length === n.length) {
            if (
                !_.isNil(v_a[i + 1]) &&
                (v_a[i + 1].substring(0, 1) === '"' ||
                    v_a[i + 1].substring(0, 1) === "{" ||
                    v_a[i + 1].substring(0, 1) === "}")
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            } else if (
                !_.isNil(p) &&
                p.length > 2 &&
                p.substring(0, 1) === '"' &&
                p.substring(p.length - 1, 1) === '"'
            ) {
                // pfri[1] = n.length-1;
            } else if (!_.isNil(v_a[i]) && v_a[i] === '")') {
                pfri[1] = 1;
            } else if (!_.isNil(v_a[i]) && v_a[i] === '"}') {
                pfri[1] = 1;
            } else if (!_.isNil(v_a[i]) && v_a[i] === "{)") {
                pfri[1] = 1;
            } else {
                pfri[1] = n.length;
            }

            return pfri;
        } else if (p.length > n.length) {
            if (
                !_.isNil(v_a[i + 1]) &&
                (v_a[i + 1].substring(0, 1) === '"' ||
                    v_a[i + 1].substring(0, 1) === "{" ||
                    v_a[i + 1].substring(0, 1) === "}")
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            }

            return pfri;
        } else if (p.length < n.length) {
            return pfri;
        }

        return pfri;
    }
    // Element added to input
    else if (vplen < vlen) {
        const i = pfri[0];
        const p = vp_a[i];
        const n = v_a[i];

        if (_.isNil(p)) {
            pfri[0] = v_a.length - 1;

            if (!_.isNil(n)) {
                pfri[1] = n.length;
            } else {
                pfri[1] = 1;
            }
        } else if (p.length === n.length) {
            if (
                vp_a[i + 1] != null &&
                (vp_a[i + 1].substring(0, 1) === '"' ||
                    vp_a[i + 1].substring(0, 1) === "{" ||
                    vp_a[i + 1].substring(0, 1) === "}")
            ) {
                pfri[1] = n.length;
            } else if (
                !_.isNil(v_a[i + 1]) &&
                v_a[i + 1].substring(0, 1) === '"' &&
                (v_a[i + 1].substring(0, 1) === "{" ||
                    v_a[i + 1].substring(0, 1) === "}")
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            } else if (
                !_.isNil(n) &&
                n.substring(0, 1) === '"' &&
                n.substring(n.length - 1, 1) === '"' &&
                p.substring(0, 1) === '"' &&
                p.substring(p.length - 1, 1) === ")"
            ) {
                pfri[1] = n.length;
            } else if (
                !_.isNil(n) &&
                n.substring(0, 1) === "{" &&
                n.substring(n.length - 1, 1) === "}" &&
                p.substring(0, 1) === "{" &&
                p.substring(p.length - 1, 1) === ")"
            ) {
                pfri[1] = n.length;
            } else {
                pfri[0] = pfri[0] + vlen - vplen;
                if (v_a.length > vp_a.length) {
                    pfri[1] = v_a[i + 1].length;
                } else {
                    pfri[1] = 1;
                }
            }

            return pfri;
        } else if (p.length > n.length) {
            if (!_.isNil(p) && p.substring(0, 1) === '"') {
                pfri[1] = n.length;
            } else if (_.isNil(v_a[i + 1]) && /{.*?}/.test(v_a[i + 1])) {
                pfri[0] += 1;
                pfri[1] = v_a[i + 1].length;
            } else if (
                !_.isNil(p) &&
                v_a[i + 1].substring(0, 1) === '"' &&
                (p.indexOf("{") > -1 || p.indexOf("}") > -1)
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            } else if (!_.isNil(p) && (p.indexOf("{") > -1 || p.indexOf("}") > -1)) {
            } else if (
                !_.isNil(p) &&
                !_.startsWith(p[0], "=") &&
                _.startsWith(n, "=")
            ) {
                return [vlen - 1, v_a[vlen - 1].length];
            } else {
                pfri[0] = pfri[0] + vlen - vplen - 1;
                pfri[1] = v_a[(i || 1) - 1].length;
            }

            return pfri;
        } else if (p.length < n.length) {
            return pfri;
        }

        return pfri;
    }

    return null;
}

export function handleFormulaInput(
    ctx: Context,
    $copyTo: HTMLDivElement | null | undefined,
    $editor: HTMLDivElement,
    kcode: number,
    preText?: string,
    refreshRangeSelect = true
) {
    let value1: string;
    const value1txt = preText ?? $editor.innerText;
    let value = $editor.innerText;
    value = escapeScriptTag(value);
    if (
        value.length > 0 &&
        value.substring(0, 1) === "=" &&
        (kcode !== 229 || value.length === 1)
    ) {
        if (!refreshRangeSelect) setRangeIndexes(getRangeIndexes($editor));
        value = functionHTMLGenerate(value);
        if (!refreshRangeSelect && formulaUIState.functionHTMLIndex < formulaUIState.rangeIndexes.length)
            refreshRangeSelect = true;
        value1 = functionHTMLGenerate(value1txt);

        resetRangeIndexes();

        if (window.getSelection) {
            // all browsers, except IE before version 9
            const currSelection = window.getSelection();
            if (!currSelection) return;
            if (currSelection.anchorNode?.nodeName.toLowerCase() === "div") {
                const editorlen = $editor.querySelectorAll("span").length;
                if (editorlen > 0)
                    ctx.formulaCache.functionRangeIndex = [
                        editorlen - 1,
                        $editor.querySelectorAll("span").item(editorlen - 1).textContent
                            ?.length!,
                    ];
            } else {
                ctx.formulaCache.functionRangeIndex = [
                    _.indexOf(
                        currSelection.anchorNode?.parentNode?.parentNode?.childNodes,
                        // @ts-ignore
                        currSelection.anchorNode?.parentNode
                    ),
                    currSelection.anchorOffset,
                ];
            }
        } else {
            // Internet Explorer before version 9
            // @ts-ignore
            const textRange = document.selection.createRange();
            ctx.formulaCache.functionRangeIndex = textRange;
        }

        $editor.innerHTML = value;
        if ($copyTo) $copyTo.innerHTML = value;

        // the cursor will be set to the beginning of input box after set innerHTML,
        // restoring it to the correct position
        functionRange(ctx, $editor, value, value1);

        if (refreshRangeSelect) {
            cancelFunctionrangeSelected(ctx);

            if (kcode !== 46) {
                // Do not execute this function on delete
                createRangeHightlight(ctx, value);
            }

            ctx.formulaCache.rangestart = false;
            ctx.formulaCache.rangedrag_column_start = false;
            ctx.formulaCache.rangedrag_row_start = false;

            rangeHightlightselected(ctx, $editor);
        }
    } else if (_.startsWith(value1txt, "=") && !_.startsWith(value, "=")) {
        if ($copyTo) $copyTo.innerHTML = value;
        $editor.innerHTML = escapeHTMLTag(value);
    } else if (!_.startsWith(value1txt, "=")) {
        if (!$copyTo) return;
        if ($copyTo.id === "luckysheet-rich-text-editor") {
            if (!_.startsWith($copyTo.innerHTML, "<span")) {
                $copyTo.innerHTML = escapeHTMLTag(value);
            }
        } else {
            $copyTo.innerHTML = escapeHTMLTag(value);
        }
    }
}
