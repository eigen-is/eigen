// Enter in a form's field, as a browser handles it and happy-dom doesn't: the field gets the keydown, and unless a
// handler prevents it, the form's first submit button is clicked. A disabled one takes no click, so nothing submits. A
// form without a submit button submits when the field is its only text field. Wrap the call in `act`.
//
// Only an enabled text field submits on Enter. Anything else throws, because a browser would do something else there:
// a textarea takes a newline, a Select trigger opens its list, and a disabled field never gets the key.
export function pressEnter(field: Element): void {
    if (!(field instanceof HTMLInputElement) || !TEXT_TYPES.has(field.type) || field.disabled) {
        throw new Error(`pressEnter needs an enabled text field, not ${field.outerHTML}`);
    }
    const keydown = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    if (!field.dispatchEvent(keydown)) return;
    const form = field.form;
    if (!form) return;
    const submit = form.querySelector<HTMLElement>('button:not([type]), button[type="submit"], input[type="submit"]');
    if (submit) submit.click();
    else if ([...form.querySelectorAll('input')].filter((input) => TEXT_TYPES.has(input.type)).length === 1) {
        form.requestSubmit();
    }
}

// The input types whose Enter submits the form, as the HTML spec lists them for implicit submission.
const TEXT_TYPES = new Set([
    'text',
    'search',
    'url',
    'tel',
    'email',
    'password',
    'number',
    'date',
    'month',
    'week',
    'time',
    'datetime-local',
]);
