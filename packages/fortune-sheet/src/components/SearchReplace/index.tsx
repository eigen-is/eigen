import {
    locale,
    normalizeSelection,
    replace,
    replaceAll,
    scrollToHighlightCell,
    searchAll,
    searchNext,
    SearchResult,
} from "../../core";
import {useCallback, useContext, useState} from "react";
import {WorkbookContext} from "../../context";
import {useAlert} from "../../hooks/useAlert";
import {useDialog} from "../../hooks/useDialog";
import {Button} from "@workspace/ui/components/button";
import {Input} from "@workspace/ui/components/input";
import {Checkbox} from "@workspace/ui/components/checkbox";
import {Label} from "@workspace/ui/components/label";
import {Tabs, TabsContent, TabsList, TabsTrigger,} from "@workspace/ui/components/tabs";
import {DialogFooter, DialogHeader, DialogTitle,} from "@workspace/ui/components/dialog";

export function SearchReplace() {
    const {context, setContext} = useContext(WorkbookContext);
    const {findAndReplace, button} = locale(context);
    const [searchText, setSearchText] = useState("");
    const [replaceText, setReplaceText] = useState("");
    const [showReplace, setShowReplace] = useState(!!context.showReplace);
    const [searchResult, setSearchResult] = useState<SearchResult[]>([]);
    const [selectedCell, setSelectedCell] = useState<{ r: number; c: number }>();
    const {showAlert} = useAlert();
    const {hideDialog} = useDialog();
    const [checkMode, setCheckMode] = useState({
        regCheck: false,
        wordCheck: false,
        caseCheck: false,
    });

    const closeDialog = useCallback(() => {
        setContext((draftCtx) => {
            draftCtx.showSearch = false;
            draftCtx.showReplace = false;
        });
        hideDialog();
    }, [setContext, hideDialog]);

    const updateCheckMode = useCallback(
        (mode: keyof typeof checkMode, value: boolean) => {
            setCheckMode((prev) => ({...prev, [mode]: value}));
        },
        []
    );

    const handleSearchAll = useCallback(() => {
        setContext((draftCtx) => {
            setSelectedCell(undefined);
            if (!searchText) return;
            const res = searchAll(draftCtx, searchText, checkMode);
            setSearchResult(res);
            if (res.length === 0) showAlert(findAndReplace.noFindTip);
        });
    }, [searchText, checkMode, setContext, showAlert, findAndReplace.noFindTip]);

    const handleSearchNext = useCallback(() => {
        setContext((draftCtx) => {
            setSearchResult([]);
            const alertMsg = searchNext(draftCtx, searchText, checkMode);
            if (alertMsg != null) showAlert(alertMsg);
        });
    }, [searchText, checkMode, setContext, showAlert]);

    const checkboxes = (
        <div className="flex gap-4 text-sm">
            <Label className="flex items-center gap-1.5">
                <Checkbox
                    checked={checkMode.regCheck}
                    onCheckedChange={(v) => updateCheckMode("regCheck", !!v)}
                />
                {findAndReplace.regexTextbox}
            </Label>
            <Label className="flex items-center gap-1.5">
                <Checkbox
                    checked={checkMode.wordCheck}
                    onCheckedChange={(v) => updateCheckMode("wordCheck", !!v)}
                />
                {findAndReplace.wholeTextbox}
            </Label>
            <Label className="flex items-center gap-1.5">
                <Checkbox
                    checked={checkMode.caseCheck}
                    onCheckedChange={(v) => updateCheckMode("caseCheck", !!v)}
                />
                {findAndReplace.distinguishTextbox}
            </Label>
        </div>
    );

    const searchField = (id: string, autoFocus: boolean) => (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
            <Label htmlFor={id}>{findAndReplace.findTextbox}</Label>
            <Input
                id={id}
                autoFocus={autoFocus}
                spellCheck={false}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") handleSearchNext();
                }}
            />
        </div>
    );

    return (
        <div className="flex flex-col min-h-0 flex-1 w-[32rem] gap-4">
            <DialogHeader>
                <DialogTitle>{findAndReplace.find}</DialogTitle>
            </DialogHeader>

            <div className="flex flex-col min-h-0 flex-1 gap-4">
                <Tabs
                    value={showReplace ? "replace" : "find"}
                    onValueChange={(v) => setShowReplace(v === "replace")}
                >
                    <TabsList>
                        <TabsTrigger value="find">{findAndReplace.find}</TabsTrigger>
                        <TabsTrigger value="replace">{findAndReplace.replace}</TabsTrigger>
                    </TabsList>

                    <TabsContent value="find" className="space-y-4 pt-4">
                        {searchField("searchInput", true)}
                        {checkboxes}
                        <div className="flex gap-2">
                            <Button variant="outline" size="sm" onClick={handleSearchAll}>
                                {findAndReplace.allFindBtn}
                            </Button>
                            <Button variant="outline" size="sm" onClick={handleSearchNext}>
                                {findAndReplace.findBtn}
                            </Button>
                        </div>
                    </TabsContent>

                    <TabsContent value="replace" className="space-y-4 pt-4">
                        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
                            <Label htmlFor="searchInputR">{findAndReplace.findTextbox}</Label>
                            <Input
                                id="searchInputR"
                                autoFocus
                                spellCheck={false}
                                value={searchText}
                                onChange={(e) => setSearchText(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") handleSearchNext();
                                }}
                            />
                            <Label htmlFor="replaceInput">{findAndReplace.replaceTextbox}</Label>
                            <Input
                                id="replaceInput"
                                spellCheck={false}
                                value={replaceText}
                                onChange={(e) => setReplaceText(e.target.value)}
                            />
                        </div>
                        {checkboxes}
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setContext((draftCtx) => {
                                        setSelectedCell(undefined);
                                        const alertMsg = replaceAll(draftCtx, searchText, replaceText, checkMode);
                                        showAlert(alertMsg);
                                    });
                                }}
                            >
                                {findAndReplace.allReplaceBtn}
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setContext((draftCtx) => {
                                        setSelectedCell(undefined);
                                        const alertMsg = replace(draftCtx, searchText, replaceText, checkMode);
                                        if (alertMsg != null) showAlert(alertMsg);
                                    });
                                }}
                            >
                                {findAndReplace.replaceBtn}
                            </Button>
                            <Button variant="outline" size="sm" onClick={handleSearchAll}>
                                {findAndReplace.allFindBtn}
                            </Button>
                            <Button variant="outline" size="sm" onClick={handleSearchNext}>
                                {findAndReplace.findBtn}
                            </Button>
                        </div>
                    </TabsContent>
                </Tabs>

                {searchResult.length > 0 && (
                    <div className="flex-1 min-h-0 border border-border rounded-md overflow-y-auto">
                        <div className="sticky top-0 bg-muted h-8 flex items-center px-2 border-b text-xs font-medium text-muted-foreground">
                            <span className="w-1/4 text-center">{findAndReplace.searchTargetSheet}</span>
                            <span className="w-1/4 text-center">{findAndReplace.searchTargetCell}</span>
                            <span className="w-1/2 text-center">{findAndReplace.searchTargetValue}</span>
                        </div>
                        {searchResult.map((v) => (
                            <div
                                className={`h-8 flex items-center px-2 border-b cursor-pointer text-sm ${
                                    selectedCell?.r === v.r && selectedCell?.c === v.c
                                        ? "bg-primary text-primary-foreground"
                                        : "hover:bg-muted/50"
                                }`}
                                key={v.cellPosition}
                                onClick={() => {
                                    setContext((draftCtx) => {
                                        draftCtx.luckysheet_select_save = normalizeSelection(
                                            draftCtx,
                                            [{row: [v.r, v.r], column: [v.c, v.c]}]
                                        );
                                        scrollToHighlightCell(draftCtx, v.r, v.c);
                                    });
                                    setSelectedCell({r: v.r, c: v.c});
                                }}
                                tabIndex={0}
                            >
                                <span className="w-1/4 text-center truncate">{v.sheetName}</span>
                                <span className="w-1/4 text-center truncate">{v.cellPosition}</span>
                                <span className="w-1/2 text-center truncate">{v.value}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <DialogFooter>
                <Button variant="outline" size="sm" onClick={closeDialog}>
                    {button.close}
                </Button>
            </DialogFooter>
        </div>
    );
}
