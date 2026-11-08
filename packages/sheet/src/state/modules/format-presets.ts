// The number and date formats the Format menu offers, in Google's groups, and the ones its date and time dialog
// lists. The custom number dialog keeps its own presets.

// The one currency the menu offers. The Custom currencies dialog reaches the others.
export const MENU_CURRENCY = '€';

export const NUMBER_MENU_PRESETS = [
    [
        { text: 'Automatic', value: 'General', example: '' },
        { text: 'Plain text', value: '@', example: '' },
    ],
    [
        { text: 'Number', value: '#,##0.00', example: '1,000.12' },
        { text: 'Percent', value: '0.00%', example: '10.12%' },
        { text: 'Scientific', value: '0.00E+00', example: '1.01E+03' },
    ],
    [
        {
            text: 'Accounting',
            value: `_(${MENU_CURRENCY}* #,##0.00_);_(${MENU_CURRENCY}* (#,##0.00);_(${MENU_CURRENCY}* "-"??_);_(@_)`,
            example: `${MENU_CURRENCY} (1,000.12)`,
        },
        { text: 'Financial', value: '#,##0.00;(#,##0.00)', example: '(1,000.12)' },
        { text: 'Currency', value: `${MENU_CURRENCY}#,##0.00`, example: `${MENU_CURRENCY}1,000.12` },
        { text: 'Currency rounded', value: `${MENU_CURRENCY}#,##0`, example: `${MENU_CURRENCY}1,000` },
    ],
    [
        { text: 'Date', value: 'dd/MM/yyyy', example: '26/09/2008' },
        { text: 'Time', value: 'HH:mm:ss', example: '15:59:00' },
        { text: 'Date time', value: 'dd/MM/yyyy HH:mm:ss', example: '26/09/2008 15:59:00' },
        { text: 'Duration', value: '[h]:mm:ss', example: '24:01:00' },
    ],
];

// Examples rendered for the fixed sample Tue 1930-08-05 13:30:30, matching
// the custom date/time dialog's preview sample.
export const DATE_FORMAT_PRESETS = [
    { name: '5-Aug-1930', value: 'd-MMM-yyyy' },
    { name: '5 Aug 1930', value: 'd MMM yyyy' },
    { name: '5 August 1930', value: 'd MMMM yyyy' },
    { name: '05/08/1930', value: 'dd/MM/yyyy' },
    { name: '05/08/30', value: 'dd/MM/yy' },
    { name: '05/08', value: 'dd/MM' },
    { name: '1930-08-05', value: 'yyyy-MM-dd' },
    { name: '13:30', value: 'HH:mm' },
    { name: '13:30:30', value: 'HH:mm:ss' },
    { name: '1:30 PM', value: 'h:mm AM/PM' },
    { name: '1:30:30 PM', value: 'h:mm:ss AM/PM' },
    { name: '05/08 13:30', value: 'dd/MM HH:mm' },
    { name: '05/08/1930 13:30', value: 'dd/MM/yyyy HH:mm' },
    { name: 'Tuesday, 5 August 1930', value: 'dddd, d MMMM yyyy' },
    { name: 'Tuesday, 5 August 1930 at 13:30:30', value: 'dddd, d MMMM yyyy "at" HH:mm:ss' },
    { name: '24:01:00 (elapsed)', value: '[h]:mm:ss' },
];
