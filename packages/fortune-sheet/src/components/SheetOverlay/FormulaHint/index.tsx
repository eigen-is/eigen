import { locale } from "@fortune-sheet/core";
import React, { useContext } from "react";
import WorkbookContext from "../../../context";

const FormulaHint: React.FC<React.HTMLAttributes<HTMLDivElement>> = (props) => {
  const { context } = useContext(WorkbookContext);
  const { formulaMore } = locale(context);
  if (!context.functionHint) return null;

  const fn = context.formulaCache.functionlistMap[context.functionHint];
  if (!fn) return null;

  return (
    <div
      {...props}
      id="luckysheet-formula-help-c"
      className="absolute border border-black/20 shadow-md text-xs text-[#535353] bg-white z-[1003] w-[300px]"
    >
      <div className="absolute top-0 right-1.5 text-base cursor-pointer text-muted-foreground hover:text-foreground" title="关闭">
        <i className="fa fa-times" aria-hidden="true" />
      </div>
      <div className="absolute top-0 right-6 text-base cursor-pointer text-muted-foreground hover:text-foreground" title="收起">
        <i className="fa fa-angle-up" aria-hidden="true" />
      </div>
      <div className="block border-y border-[#ebebeb] bg-[#f5f5f5] px-2.5 py-0.5 text-sm">
        <div className="w-[250px] break-words">
          <span className="luckysheet-arguments-help-function-name">
            {fn.n}
          </span>
          <span className="luckysheet-arguments-paren">(</span>
          <span className="luckysheet-arguments-parameter-holder">
            {fn.p.map((param: any, i: number) => {
              let { name } = param;
              if (param.repeat === "y") {
                name += ", ...";
              }
              if (param.require === "o") {
                name = `[${name}]`;
              }
              return (
                <span
                  className="luckysheet-arguments-help-parameter"
                  dir="auto"
                  key={name}
                >
                  {name}
                  {i !== fn.p.length - 1 && ", "}
                </span>
              );
            })}
          </span>
          <span className="luckysheet-arguments-paren">)</span>
        </div>
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        <div className="mt-1.5">
          <div className="px-2.5 py-px text-[#666]">
            {formulaMore.helpExample}
          </div>
          <div className="px-2.5 py-px text-sm">
            <span className="luckysheet-arguments-help-function-name">
              {fn.n}
            </span>
            <span className="luckysheet-arguments-paren">(</span>
            <span className="luckysheet-arguments-parameter-holder">
              {fn.p.map((param: any, i: number) => (
                <span
                  key={param.name}
                  className="luckysheet-arguments-help-parameter"
                  dir="auto"
                >
                  {param.example}
                  {i !== fn.p.length - 1 && ", "}
                </span>
              ))}
            </span>
            <span className="luckysheet-arguments-paren">)</span>
          </div>
        </div>
        <div className="luckysheet-formula-help-content-detail">
          <div className="my-1.5 text-[#222]">
            <div className="px-2.5 py-px text-[#666]">
              {formulaMore.helpAbstract}
            </div>
            <span className="px-2.5 py-px inline-block break-words">
              {fn.d}
            </span>
          </div>
        </div>
        <div className="luckysheet-formula-help-content-param">
          {fn.p.map((param: any) => (
            <div className="my-1.5 text-[#222]" key={param.name}>
              <div className="px-2.5 py-px text-[#666]">
                {param.name}
                {param.repeat === "y" && (
                  <span className="luckysheet-arguments-help-argument-info">
                    ...-{formulaMore.allowRepeatText}
                  </span>
                )}
                {param.require === "o" && (
                  <span className="text-sm text-gray-500">
                    -[{formulaMore.allowOptionText}]
                  </span>
                )}
              </div>
              <span className="px-2.5 py-px inline-block break-words">
                {param.detail}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="luckysheet-formula-help-foot" />
    </div>
  );
};

export default FormulaHint;
