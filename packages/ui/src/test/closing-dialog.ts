// Lets a test read a dialog while it closes. Radix keeps a closing dialog mounted while its exit animation runs, but
// happy-dom computes no animation from a style sheet and never ends one. While this holds, a dialog's content reports
// a fade-out once it closes, so it stays in the document with data-state="closed". Call what it returns to let go.
export function holdClosingDialogs(): () => void {
    const realGetComputedStyle = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (element, pseudo) => {
        const style = realGetComputedStyle(element, pseudo);
        if (!(element instanceof HTMLElement) || element.dataset.slot !== 'dialog-content') return style;
        return new Proxy(style, {
            get: (target, key) =>
                key === 'animationName'
                    ? element.dataset.state === 'closed'
                        ? 'fade-out'
                        : 'fade-in'
                    : Reflect.get(target, key),
        });
    };
    return () => {
        globalThis.getComputedStyle = realGetComputedStyle;
    };
}

export const closingDialog = () => document.querySelector('[role="dialog"][data-state="closed"]');
