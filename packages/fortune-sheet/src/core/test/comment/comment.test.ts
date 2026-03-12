import {cellPs, editingCommentBox} from "../factories/cell";
import {contextFactory} from "../factories/context";
import {Context} from "../../context";
import {GlobalCache} from "../../types";
import {deleteComment, newComment, showHideAllComments, showHideComment,} from "../../modules/comment";
import {describe, expect, test} from "bun:test";

describe("fortune-sheet/core/modules/comment", () => {
    const getContext = () => contextFactory() as Context;
    const getCache = (): GlobalCache => ({
        undoList: [],
        redoList: [],
        scrollLeft: 0,
        scrollTop: 0,
        scrollListeners: new Set(),
        notifyScrollListeners: () => {
        },
        editingCommentBoxEle: {dataset: {r: 0, c: 0}} as any,
    });
    const expectedEditingCommentBox = editingCommentBox({r: 0, c: 0});
    const expectedCellPs = cellPs();

    test("new comment and delete comment", async () => {
        const ctx = getContext();
        const cache = getCache();
        newComment(ctx, cache, 0, 0);
        expect(ctx.luckysheetfile[0]?.data?.[0]?.[0]?.ps).toEqual(expectedCellPs);
        expect(ctx.editingCommentBox).toEqual(expectedEditingCommentBox);
        deleteComment(ctx, cache, 0, 0);
        expect(ctx.luckysheetfile[0]?.data?.[0]?.[0]?.ps).toBeUndefined();
    });
    test("show comment and hide comment", async () => {
        const ctx = getContext();
        const cache = getCache();
        newComment(ctx, cache, 0, 0);
        showHideComment(ctx, cache, 0, 0);
        expect(ctx.luckysheetfile[0]?.data?.[0]?.[0]?.ps?.isShow).toBe(true);
        showHideComment(ctx, cache, 0, 0);
        expect(ctx.luckysheetfile[0]?.data?.[0]?.[0]?.ps?.isShow).toBe(false);
    });
    test("show all comments and hide all comments", async () => {
        const ctx = getContext();
        const cache = getCache();
        newComment(ctx, cache, 0, 0);
        newComment(ctx, cache, 1, 1);
        showHideAllComments(ctx);
        expect(ctx.luckysheetfile[0]?.data?.[0]?.[0]?.ps?.isShow).toBe(true);
        expect(ctx.luckysheetfile[0]?.data?.[1]?.[1]?.ps?.isShow).toBe(true);
        showHideAllComments(ctx);
        expect(ctx.luckysheetfile[0]?.data?.[0]?.[0]?.ps?.isShow).toBe(false);
        expect(ctx.luckysheetfile[0]?.data?.[1]?.[1]?.ps?.isShow).toBe(false);
    });
});
