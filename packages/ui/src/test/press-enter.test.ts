// pressEnter submits only where a browser's Enter would, and refuses a field where the browser would do something else.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from './happy-dom';
import { pressEnter } from './press-enter';

installHappyDom();

afterEach(() => {
    document.body.innerHTML = '';
});

function form(html: string) {
    const element = document.createElement('form');
    element.innerHTML = html;
    const onSubmit = mock((event: Event) => event.preventDefault());
    element.addEventListener('submit', onSubmit);
    document.body.append(element);
    const field = element.querySelector('[data-field]');
    if (!field) throw new Error('no field');
    return { field, onSubmit };
}

test('Enter in a text field clicks the first submit button', () => {
    const { field, onSubmit } = form('<input data-field type="email"><button>Save</button>');
    pressEnter(field);
    expect(onSubmit).toHaveBeenCalledTimes(1);
});

test('an input of type submit counts as the submit button, so a disabled one submits nothing', () => {
    const enabled = form('<input data-field><input type="text"><input type="submit" value="Save">');
    pressEnter(enabled.field);
    expect(enabled.onSubmit).toHaveBeenCalledTimes(1);

    const disabled = form('<input data-field><input type="text"><input type="submit" value="Save" disabled>');
    pressEnter(disabled.field);
    expect(disabled.onSubmit).not.toHaveBeenCalled();
});

test('a form with no submit button submits only when the field is its one text field', () => {
    const alone = form('<input data-field><input type="checkbox">');
    pressEnter(alone.field);
    expect(alone.onSubmit).toHaveBeenCalledTimes(1);

    const two = form('<input data-field><input type="search">');
    pressEnter(two.field);
    expect(two.onSubmit).not.toHaveBeenCalled();
});

test('a textarea, a button or a disabled field throws instead of submitting', () => {
    for (const html of [
        '<textarea data-field></textarea><button>Save</button>',
        '<button data-field type="button" role="combobox">Letter</button><button>Save</button>',
        '<input data-field disabled><button>Save</button>',
        '<input data-field type="checkbox"><button>Save</button>',
    ]) {
        const { field, onSubmit } = form(html);
        expect(() => pressEnter(field)).toThrow('pressEnter needs an enabled text field');
        expect(onSubmit).not.toHaveBeenCalled();
    }
});
