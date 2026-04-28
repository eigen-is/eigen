import { ChevronUp, X } from 'lucide-react';
import type React from 'react';
import { useContext } from 'react';
import { WorkbookContext } from '../../../context';
import { locale } from '../../../state';

type FormulaParam = {
    name: string;
    detail?: string;
    example?: string;
    require?: string;
    repeat?: string;
    type?: string;
};

type FormulaFunctionEntry = {
    n: string;
    d?: string;
    p: FormulaParam[];
};

export const FormulaHint: React.FC<React.HTMLAttributes<HTMLDivElement>> = (props) => {
    const { context } = useContext(WorkbookContext);
    const { formulaMore } = locale(context);
    if (!context.functionHint) return null;

    const fn = context.formulaCache.functionlistMap[context.functionHint] as FormulaFunctionEntry | undefined;
    if (!fn) return null;

    return (
        <div {...props} className="absolute z-[1003] w-[300px] border border-border bg-background shadow-md text-xs">
            <div
                className="absolute top-0 right-1.5 cursor-pointer text-base text-muted-foreground hover:text-foreground"
                title="Close"
            >
                <X size={14} aria-hidden="true" />
            </div>
            <div
                className="absolute top-0 right-6 cursor-pointer text-base text-muted-foreground hover:text-foreground"
                title="Collapse"
            >
                <ChevronUp size={14} aria-hidden="true" />
            </div>
            <div className="border-y border-border bg-muted px-2.5 py-0.5 text-sm">
                <div className="w-[250px] break-words">
                    <span>{fn.n}</span>
                    <span>(</span>
                    <span>
                        {fn.p.map((param, i) => {
                            let { name } = param;
                            if (param.repeat === 'y') {
                                name += ', ...';
                            }
                            if (param.require === 'o') {
                                name = `[${name}]`;
                            }
                            return (
                                <span dir="auto" key={name}>
                                    {name}
                                    {i !== fn.p.length - 1 && ', '}
                                </span>
                            );
                        })}
                    </span>
                    <span>)</span>
                </div>
            </div>
            <div className="max-h-[300px] overflow-y-auto">
                <div className="mt-1.5">
                    <div className="px-2.5 py-px text-muted-foreground">{formulaMore.helpExample}</div>
                    <div className="px-2.5 py-px text-sm">
                        <span>{fn.n}</span>
                        <span>(</span>
                        <span>
                            {fn.p.map((param, i) => (
                                <span key={param.name} dir="auto">
                                    {param.example}
                                    {i !== fn.p.length - 1 && ', '}
                                </span>
                            ))}
                        </span>
                        <span>)</span>
                    </div>
                </div>
                <div className="my-1.5">
                    <div className="px-2.5 py-px text-muted-foreground">{formulaMore.helpAbstract}</div>
                    <span className="inline-block px-2.5 py-px break-words">{fn.d}</span>
                </div>
                {fn.p.map((param) => (
                    <div className="my-1.5" key={param.name}>
                        <div className="px-2.5 py-px text-muted-foreground">
                            {param.name}
                            {param.repeat === 'y' && <span>{`...-${formulaMore.allowRepeatText}`}</span>}
                            {param.require === 'o' && (
                                <span className="text-sm">{`-[${formulaMore.allowOptionText}]`}</span>
                            )}
                        </div>
                        <span className="inline-block px-2.5 py-px break-words">{param.detail}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};
