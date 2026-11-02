// Enter or Space on a focused control, as a browser handles it and happy-dom doesn't: an enabled button is clicked,
// unless a handler prevents the keydown. Anything else only gets the key events, so a div that listens for clicks alone
// does nothing, as in a browser. Wrap the call in `act`.
export function pressKey(target: Element, key: 'Enter' | ' '): void {
    const keydown = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    const activates = target.dispatchEvent(keydown);
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    if (activates && target instanceof HTMLButtonElement && !target.disabled) target.click();
}
