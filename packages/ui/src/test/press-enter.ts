// Enter in a form's field, as a browser handles it and happy-dom doesn't: the field gets the keydown, and unless a
// handler prevents it, the form's first submit button is clicked. A disabled one takes no click, so nothing submits. A
// form without a submit button submits when the field is its only text field. Wrap the call in `act`.
export function pressEnter(field: Element): void {
    const keydown = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    if (!field.dispatchEvent(keydown)) return;
    const form = field.closest('form');
    if (!form) return;
    const submit = form.querySelector<HTMLButtonElement>('button:not([type]), button[type="submit"]');
    if (submit) submit.click();
    else if (form.querySelectorAll('input:not([type="checkbox"], [type="radio"], [type="hidden"])').length === 1) {
        form.requestSubmit();
    }
}
