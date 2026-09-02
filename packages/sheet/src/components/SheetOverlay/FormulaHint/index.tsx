import { useContext } from 'react';
import { WorkbookContext } from '../../../context';
import type { FormulaFunctionEntry } from '../../../state';
import { FormulaPopup } from '../FormulaPopup';

type FormulaHintProps = {
    anchorRef: { readonly current: HTMLElement | null };
    open: boolean;
};

export function FormulaHint({ anchorRef, open }: FormulaHintProps) {
    const { context } = useContext(WorkbookContext);
    const fn = context.functionHint
        ? (context.formulaCache.functionlistMap[context.functionHint] as FormulaFunctionEntry | undefined)
        : undefined;

    return (
        <FormulaPopup anchorRef={anchorRef} open={open && !!fn}>
            {fn && (
                <>
                    <div className="border-b border-border bg-muted px-2.5 py-1 text-sm">
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
                    <div className="space-y-3 px-2.5 py-2 text-xs">
                        <div>
                            <div className="text-muted-foreground">Example</div>
                            <div className="text-sm">
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
                        <div>
                            <div className="text-muted-foreground">Abstract</div>
                            <div className="break-words">{fn.d}</div>
                        </div>
                        {fn.p.map((param) => (
                            <div key={param.name}>
                                <div className="text-muted-foreground">
                                    {param.name}
                                    {param.repeat === 'y' && <span>...-Repeatable</span>}
                                    {param.require === 'o' && <span>-[Optional]</span>}
                                </div>
                                <div className="break-words">{param.detail}</div>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </FormulaPopup>
    );
}
