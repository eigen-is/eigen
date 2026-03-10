import {
  locale,
  searchAll,
  searchNext,
  SearchResult,
  normalizeSelection,
  onSearchDialogMoveStart,
  replace,
  replaceAll,
  scrollToHighlightCell,
} from "../../core";
import produce from "immer";
import React, { useContext, useState, useCallback } from "react";
import _ from "lodash";
import WorkbookContext from "../../context";
import { useAlert } from "../../hooks/useAlert";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Label } from "@workspace/ui/components/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@workspace/ui/components/tabs";
import { X } from "lucide-react";

const SearchReplace: React.FC<{
  getContainer: () => HTMLDivElement;
}> = ({ getContainer }) => {
  const { context, setContext, refs } = useContext(WorkbookContext);
  const { findAndReplace, button } = locale(context);
  const [searchText, setSearchText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showReplace, setShowReplace] = useState(context.showReplace);
  const [searchResult, setSearchResult] = useState<SearchResult[]>([]);
  const [selectedCell, setSelectedCell] = useState<{ r: number; c: number }>();
  const { showAlert } = useAlert();
  const [checkMode, checkModeReplace] = useState({
    regCheck: false,
    wordCheck: false,
    caseCheck: false,
  });

  const closeDialog = useCallback(() => {
    _.set(refs.globalCache, "searchDialog.mouseEnter", false);
    setContext((draftCtx) => {
      draftCtx.showSearch = false;
      draftCtx.showReplace = false;
    });
  }, [refs.globalCache, setContext]);

  const setCheckMode = useCallback(
    (mode: string, value: boolean) =>
      checkModeReplace(
        produce((draft) => {
          _.set(draft, mode, value);
        })
      ),
    []
  );

  const getInitialPosition = useCallback((container: HTMLDivElement) => {
    const rect = container.getBoundingClientRect();
    return {
      left: (rect.width - 500) / 2,
      top: (rect.height - 200) / 3,
    };
  }, []);

  return (
    <div
      id="fortune-search-replace"
      className="absolute z-[1002] bg-background border rounded-lg shadow-lg p-4 min-w-[520px]"
      style={getInitialPosition(getContainer())}
      onMouseEnter={() => {
        _.set(refs.globalCache, "searchDialog.mouseEnter", true);
      }}
      onMouseLeave={() => {
        _.set(refs.globalCache, "searchDialog.mouseEnter", false);
      }}
      onMouseDown={(e) => {
        const { nativeEvent } = e;
        onSearchDialogMoveStart(refs.globalCache, nativeEvent, getContainer());
        e.stopPropagation();
      }}
    >
      <div onMouseDown={(e) => e.stopPropagation()}>
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-2 top-2"
          onClick={closeDialog}
        >
          <X className="size-4" />
        </Button>

        <Tabs
          value={showReplace ? "replace" : "find"}
          onValueChange={(v) => setShowReplace(v === "replace")}
        >
          <TabsList>
            <TabsTrigger value="find">{findAndReplace.find}</TabsTrigger>
            <TabsTrigger value="replace">{findAndReplace.replace}</TabsTrigger>
          </TabsList>

          <TabsContent value="find" className="space-y-3 pt-3">
            <div className="flex gap-4">
              <div className="flex-1 space-y-2">
                <Label htmlFor="searchInput">{findAndReplace.findTextbox}</Label>
                <Input
                  id="searchInput"
                  autoFocus
                  spellCheck={false}
                  onKeyDown={(e) => e.stopPropagation()}
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                />
              </div>
              <div className="space-y-2 pt-5">
                <Label className="flex items-center gap-2">
                  <Checkbox checked={checkMode.regCheck} onCheckedChange={(v) => setCheckMode("regCheck", !!v)} />
                  {findAndReplace.regexTextbox}
                </Label>
                <Label className="flex items-center gap-2">
                  <Checkbox checked={checkMode.wordCheck} onCheckedChange={(v) => setCheckMode("wordCheck", !!v)} />
                  {findAndReplace.wholeTextbox}
                </Label>
                <Label className="flex items-center gap-2">
                  <Checkbox checked={checkMode.caseCheck} onCheckedChange={(v) => setCheckMode("caseCheck", !!v)} />
                  {findAndReplace.distinguishTextbox}
                </Label>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setContext((draftCtx) => {
                setSelectedCell(undefined);
                if (!searchText) return;
                const res = searchAll(draftCtx, searchText, checkMode);
                setSearchResult(res);
                if (_.isEmpty(res)) showAlert(findAndReplace.noFindTip);
              })}>
                {findAndReplace.allFindBtn}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setContext((draftCtx) => {
                setSearchResult([]);
                const alertMsg = searchNext(draftCtx, searchText, checkMode);
                if (alertMsg != null) showAlert(alertMsg);
              })}>
                {findAndReplace.findBtn}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="replace" className="space-y-3 pt-3">
            <div className="flex gap-4">
              <div className="flex-1 space-y-2">
                <Label htmlFor="searchInputR">{findAndReplace.findTextbox}</Label>
                <Input
                  id="searchInputR"
                  autoFocus
                  spellCheck={false}
                  onKeyDown={(e) => e.stopPropagation()}
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                />
                <Label htmlFor="replaceInput">{findAndReplace.replaceTextbox}</Label>
                <Input
                  id="replaceInput"
                  spellCheck={false}
                  onKeyDown={(e) => e.stopPropagation()}
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                />
              </div>
              <div className="space-y-2 pt-5">
                <Label className="flex items-center gap-2">
                  <Checkbox checked={checkMode.regCheck} onCheckedChange={(v) => setCheckMode("regCheck", !!v)} />
                  {findAndReplace.regexTextbox}
                </Label>
                <Label className="flex items-center gap-2">
                  <Checkbox checked={checkMode.wordCheck} onCheckedChange={(v) => setCheckMode("wordCheck", !!v)} />
                  {findAndReplace.wholeTextbox}
                </Label>
                <Label className="flex items-center gap-2">
                  <Checkbox checked={checkMode.caseCheck} onCheckedChange={(v) => setCheckMode("caseCheck", !!v)} />
                  {findAndReplace.distinguishTextbox}
                </Label>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                setContext((draftCtx) => {
                  setSelectedCell(undefined);
                  const alertMsg = replaceAll(draftCtx, searchText, replaceText, checkMode);
                  showAlert(alertMsg);
                });
              }}>
                {findAndReplace.allReplaceBtn}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setContext((draftCtx) => {
                setSelectedCell(undefined);
                const alertMsg = replace(draftCtx, searchText, replaceText, checkMode);
                if (alertMsg != null) showAlert(alertMsg);
              })}>
                {findAndReplace.replaceBtn}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setContext((draftCtx) => {
                setSelectedCell(undefined);
                if (!searchText) return;
                const res = searchAll(draftCtx, searchText, checkMode);
                setSearchResult(res);
                if (_.isEmpty(res)) showAlert(findAndReplace.noFindTip);
              })}>
                {findAndReplace.allFindBtn}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setContext((draftCtx) => {
                setSearchResult([]);
                const alertMsg = searchNext(draftCtx, searchText, checkMode);
                if (alertMsg != null) showAlert(alertMsg);
              })}>
                {findAndReplace.findBtn}
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        <div className="mt-2">
          <Button variant="outline" size="sm" onClick={closeDialog}>
            {button.close}
          </Button>
        </div>

        {searchResult.length > 0 && (
          <div className="h-[210px] border rounded mt-3 overflow-y-auto relative">
            <div className="sticky top-0 bg-background h-[30px] leading-[29px] px-1.5 border-b flex">
              <span className="w-1/4 text-center text-sm">{findAndReplace.searchTargetSheet}</span>
              <span className="w-1/4 text-center text-sm">{findAndReplace.searchTargetCell}</span>
              <span className="w-1/2 text-center text-sm">{findAndReplace.searchTargetValue}</span>
            </div>
            <div>
              {searchResult.map((v) => (
                <div
                  className={`h-[30px] leading-[29px] border-b px-1.5 flex cursor-pointer ${
                    _.isEqual(selectedCell, { r: v.r, c: v.c })
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted"
                  }`}
                  key={v.cellPosition}
                  onClick={() => {
                    setContext((draftCtx) => {
                      draftCtx.luckysheet_select_save = normalizeSelection(
                        draftCtx,
                        [{ row: [v.r, v.r], column: [v.c, v.c] }]
                      );
                      scrollToHighlightCell(draftCtx, v.r, v.c);
                    });
                    setSelectedCell({ r: v.r, c: v.c });
                  }}
                  tabIndex={0}
                >
                  <span className="w-1/4 text-center truncate text-sm">{v.sheetName}</span>
                  <span className="w-1/4 text-center truncate text-sm">{v.cellPosition}</span>
                  <span className="w-1/2 text-center truncate text-sm">{v.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchReplace;
