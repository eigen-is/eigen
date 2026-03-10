import React, { useCallback, useContext } from "react";
import { locale, updateItem } from "../../core";
import WorkbookContext from "../../context";
import { useDialog } from "../../hooks/useDialog";
import ConditionRules from "./ConditionRules";
import {
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuItem,
} from "@workspace/ui/components/dropdown-menu";

const ConditionalFormat: React.FC<{
  items: string[];
}> = ({ items }) => {
  const { context, setContext } = useContext(WorkbookContext);
  const { showDialog } = useDialog();
  const { conditionformat } = locale(context);

  const getConditionFormatItem = useCallback(
    (name: string) => {
      if (name === "-") {
        return <DropdownMenuSeparator key={name} />;
      }
      if (name === "highlightCellRules") {
        return (
          <DropdownMenuSub key={name}>
            <DropdownMenuSubTrigger>
              {conditionformat[name]}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {[
                { text: "greaterThan", value: ">" },
                { text: "lessThan", value: "<" },
                { text: "between", value: "[]" },
                { text: "equal", value: "=" },
                { text: "textContains", value: "()" },
                { text: "occurrenceDate", value: conditionformat.yesterday },
                { text: "duplicateValue", value: "##" },
              ].map((v) => (
                <DropdownMenuItem
                  key={v.text}
                  onClick={() => {
                    showDialog(<ConditionRules type={v.text} />);
                  }}
                >
                  <div className="flex items-center justify-between w-full">
                    <span>{(conditionformat as any)[v.text]}</span>
                    <span className="text-xs opacity-50 ml-4">{v.value}</span>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      }
      if (name === "itemSelectionRules") {
        return (
          <DropdownMenuSub key={name}>
            <DropdownMenuSubTrigger>
              {conditionformat[name]}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {[
                { text: "top10", value: conditionformat.top10 },
                { text: "top10_percent", value: conditionformat.top10_percent },
                { text: "last10", value: conditionformat.last10 },
                { text: "last10_percent", value: conditionformat.last10_percent },
                { text: "aboveAverage", value: conditionformat.above },
                { text: "belowAverage", value: conditionformat.below },
              ].map((v) => (
                <DropdownMenuItem
                  key={v.text}
                  onClick={() => {
                    showDialog(<ConditionRules type={v.text} />);
                  }}
                >
                  <div className="flex items-center justify-between w-full">
                    <span>{(conditionformat as any)[v.text]}</span>
                    <span className="text-xs opacity-50 ml-4">{v.value}</span>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      }
      if (name === "deleteRule") {
        return (
          <DropdownMenuSub key={name}>
            <DropdownMenuSubTrigger>
              {conditionformat[name]}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {["deleteSheetRule"].map((v) => (
                <DropdownMenuItem
                  key={v}
                  onClick={() => {
                    setContext((ctx) => {
                      updateItem(ctx, "delSheet");
                    });
                  }}
                >
                  {(conditionformat as any)[v]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      }

      return null;
    },
    [conditionformat, setContext, showDialog]
  );

  return <>{items.map((v) => getConditionFormatItem(v))}</>;
};

export default ConditionalFormat;
