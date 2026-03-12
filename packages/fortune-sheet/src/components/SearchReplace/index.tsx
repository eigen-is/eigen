import {
  locale,
  searchAll,
  searchNext,
  SearchResult,
  normalizeSelection,
  replace,
  replaceAll,
  scrollToHighlightCell,
} from "../../core";
import {useContext, useState, useCallback} from "react";
import WorkbookContext from "../../context";
import { useAlert } from "../../hooks/useAlert";
import {useDialog} from "../../hooks/useDialog";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Label } from "@workspace/ui/components/label";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs";
import {
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@workspace/ui/components/dialog";

export default function SearchReplace() {
  const {context, setContext} = useContext(WorkbookContext);
  const { findAndReplace, button } = locale(context);
  const [searchText, setSearchText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showReplace, setShowReplace] = useState(!!context.showReplace);
  const [searchResult, setSearchResult] = useState<SearchResult[]>([]);
  const [selectedCell, setSelectedCell] = useState<{ r: number; c: number }>();
  const { showAlert } = useAlert();
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

  const checkboxes = (
      <div className="space-y-2 pt-5">
        <Label className="flex items-center gap-2">
          <Checkbox
              checked={checkMode.regCheck}
              onCheckedChange={(v) => updateCheckMode("regCheck", !!v)}
          />
          {findAndReplace.regexTextbox}
        </Label>
        <Label className="flex items-center gap-2">
          <Checkbox
              checked={checkMode.wordCheck}
              onCheckedChange={(v) => updateCheckMode("wordCheck", !!v)}
          />
          {findAndReplace.wholeTextbox}
        </Label>
        <Label className="flex items-center gap-2">
          <Checkbox
              checked={checkMode.caseCheck}
              onCheckedChange={(v) => updateCheckMode("caseCheck", !!v)}
          />
          {findAndReplace.distinguishTextbox}
        </Label>
      </div>
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

  return (
      <div className="min-w-[480px]">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle>{findAndReplace.find}</DialogTitle>
        </DialogHeader>

        <div className="px-6 py-4">
        <Tabs
          value={showReplace ? "replace" : "find"}
          onValueChange={(v) => setShowReplace(v === "replace")}
        >
          <TabsList>
            <TabsTrigger value="find">{findAndReplace.find}</TabsTrigger>
            <TabsTrigger value="replace">
              {findAndReplace.replace}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="find" className="space-y-3 pt-3">
            <div className="flex gap-4">
              <div className="flex-1 space-y-2">
                <Label htmlFor="searchInput">
                  {findAndReplace.findTextbox}
                </Label>
                <Input
                  id="searchInput"
                  autoFocus
                  spellCheck={false}
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSearchNext();
                  }}
                />
              </div>
              {checkboxes}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleSearchAll}>
                {findAndReplace.allFindBtn}
              </Button>
              <Button variant="outline" size="sm" onClick={handleSearchNext}>
                {findAndReplace.findBtn}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="replace" className="space-y-3 pt-3">
            <div className="flex gap-4">
              <div className="flex-1 space-y-2">
                <Label htmlFor="searchInputR">
                  {findAndReplace.findTextbox}
                </Label>
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
                <Label htmlFor="replaceInput">
                  {findAndReplace.replaceTextbox}
                </Label>
                <Input
                  id="replaceInput"
                  spellCheck={false}
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                />
              </div>
              {checkboxes}
            </div>
            <div className="flex gap-2">
              <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setContext((draftCtx) => {
                      setSelectedCell(undefined);
                      const alertMsg = replaceAll(
                          draftCtx,
                          searchText,
                          replaceText,
                          checkMode
                      );
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
                      const alertMsg = replace(
                          draftCtx,
                          searchText,
                          replaceText,
                          checkMode
                      );
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
          <div className="h-[210px] border rounded mt-3 overflow-y-auto relative">
            <div
                className="sticky top-0 bg-background h-[30px] leading-[29px] px-1.5 border-b flex text-sm font-medium">
              <span className="w-1/4 text-center">
                {findAndReplace.searchTargetSheet}
              </span>
              <span className="w-1/4 text-center">
                {findAndReplace.searchTargetCell}
              </span>
              <span className="w-1/2 text-center">
                {findAndReplace.searchTargetValue}
              </span>
            </div>
            <div>
              {searchResult.map((v) => (
                <div
                    className={`h-[30px] leading-[29px] border-b px-1.5 flex cursor-pointer text-sm ${
                        selectedCell?.r === v.r && selectedCell?.c === v.c
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
                  <span className="w-1/4 text-center truncate">
                    {v.sheetName}
                  </span>
                  <span className="w-1/4 text-center truncate">
                    {v.cellPosition}
                  </span>
                  <span className="w-1/2 text-center truncate">
                    {v.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

        <DialogFooter className="p-6 pt-0">
          <Button variant="outline" size="sm" onClick={closeDialog}>
            {button.close}
          </Button>
        </DialogFooter>
    </div>
  );
}
