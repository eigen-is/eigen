// The data of the "Tuimel Festival" demo world, a small volunteer-run arts and music festival three weeks out: its
// personas, folders and the text of its documents, mail, events, chats and contacts, plus a few small helpers that
// spell or read some of it, such as an equation's MathML and a thread's times. The demo seeder turns it into a live
// workspace through the real product surfaces, so a richer pass changes data here, not mechanics. Personas resolve
// by `<key>@<MAIL_DOMAIN>`, so ids may differ per rebuild. All names, acts and vendors are fictional.

import { localToUtc, utcToLocal } from '@workspace/lib/calendar/calendar-utils';
import { CHART_DEFAULT_SIZE, FLAT_CHART_LOOK, newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import { escapeHtml } from '@workspace/lib/html';
import type { FillPaint } from '@workspace/lib/types/background';
import type { Attendee } from '@workspace/lib/types/calendar';
import type { ChartType } from '@workspace/lib/types/chart';
import type {
    Arrowhead,
    Corners,
    FillStyle,
    Roundness,
    StrokeStyle,
    TextAlign,
    VerticalAlign,
} from '@workspace/lib/vector';
import { solidFill } from '@workspace/lib/vector';
import { readLatex, writeMathml } from '@workspace/math';

export type LeadRole =
    | 'director'
    | 'programming'
    | 'production'
    | 'comms'
    | 'volunteers'
    | 'finance'
    | 'tech'
    | 'liaison';

export type Persona = {
    key: string; // email local-part, stable across rebuilds
    name: string;
    title: string;
    role?: LeadRole; // set for the 8 named leads
    avatar: string; // fixture filename under fixtures/avatars/ (curated Unsplash portrait, see CREDITS.md)
    phone: string;
};

// 8 named leads do the visible authoring; 12 lighter crew fill the roster and @-mention lists.
export const PERSONAS: Persona[] = [
    {
        key: 'anouk',
        name: 'Anouk de Wit',
        title: 'Festival director',
        role: 'director',
        avatar: 'anouk.jpg',
        phone: '+31 6 2010 4401',
    },
    {
        key: 'joris',
        name: 'Joris Bakker',
        title: 'Programming lead',
        role: 'programming',
        avatar: 'joris.jpg',
        phone: '+31 6 2010 4402',
    },
    {
        key: 'saar',
        name: 'Saar Vermeer',
        title: 'Production & logistics lead',
        role: 'production',
        avatar: 'saar.jpg',
        phone: '+31 6 2010 4403',
    },
    {
        key: 'mees',
        name: 'Mees de Groot',
        title: 'Comms & marketing',
        role: 'comms',
        avatar: 'mees.jpg',
        phone: '+31 6 2010 4404',
    },
    {
        key: 'nour',
        name: 'Nour El Amrani',
        title: 'Volunteer coordinator',
        role: 'volunteers',
        avatar: 'nour.jpg',
        phone: '+31 6 2010 4405',
    },
    {
        key: 'bram',
        name: 'Bram Visser',
        title: 'Finance & ticketing',
        role: 'finance',
        avatar: 'bram.jpg',
        phone: '+31 6 2010 4406',
    },
    {
        key: 'timo',
        name: 'Timo Jansen',
        title: 'Stage & tech lead',
        role: 'tech',
        avatar: 'timo.jpg',
        phone: '+31 6 2010 4407',
    },
    {
        key: 'lieke',
        name: 'Lieke Smits',
        title: 'Artist liaison & hospitality',
        role: 'liaison',
        avatar: 'lieke.jpg',
        phone: '+31 6 2010 4408',
    },
    { key: 'fenna', name: 'Fenna Bos', title: 'Bar coordinator', avatar: 'fenna.jpg', phone: '+31 6 2010 4409' },
    { key: 'daan', name: 'Daan Mulder', title: 'Gate & wristbands', avatar: 'daan.jpg', phone: '+31 6 2010 4410' },
    { key: 'sanne', name: 'Sanne Kok', title: 'Stage crew', avatar: 'sanne.jpg', phone: '+31 6 2010 4411' },
    { key: 'ravi', name: 'Ravi Nair', title: 'Site crew', avatar: 'ravi.jpg', phone: '+31 6 2010 4412' },
    { key: 'joost', name: 'Joost Peters', title: 'Workshops host', avatar: 'joost.jpg', phone: '+31 6 2010 4413' },
    { key: 'imke', name: 'Imke de Vries', title: 'First aid', avatar: 'imke.jpg', phone: '+31 6 2010 4414' },
    { key: 'lars', name: 'Lars Hendriks', title: 'Waste & recycling', avatar: 'lars.jpg', phone: '+31 6 2010 4415' },
    { key: 'yara', name: 'Yara Haddad', title: 'Camping host', avatar: 'yara.jpg', phone: '+31 6 2010 4416' },
    { key: 'pieter', name: 'Pieter van Dijk', title: 'Box office', avatar: 'pieter.jpg', phone: '+31 6 2010 4417' },
    { key: 'maud', name: 'Maud Willems', title: 'Runner', avatar: 'maud.jpg', phone: '+31 6 2010 4418' },
    { key: 'sem', name: 'Sem Dekker', title: 'Décor & art', avatar: 'sem.jpg', phone: '+31 6 2010 4419' },
    { key: 'tessa', name: 'Tessa Meijer', title: 'Sound assistant', avatar: 'tessa.jpg', phone: '+31 6 2010 4420' },
];

export const ADMIN_NAME = 'Tuimel Admin';
export const ADMIN_LOCALPART = 'office';
// The mail domain the seeder uses when MAIL_DOMAIN is unset.
export const DEMO_MAIL_DOMAIN = 'tuimel.example';
// The festival is Dutch, so every seeded time is on this clock, whatever zone the demo server runs in.
export const DEMO_TIME_ZONE = 'Europe/Amsterdam';
export const ADMIN_AVATAR = 'admin.jpg';
export const ORG_NAME = 'Tuimel Festival';
export const TEAM_NAME = 'festival crew';
// A second team, for the stage and tech crew. Saar shares her site access notes with it.
export const TECH_TEAM_NAME = 'stage & tech';
export const TECH_TEAM_MEMBERS = ['timo', 'sanne', 'tessa'];
export const TEAM_MOUNT_NAME = 'festival';

// All seeded directory and file names are lowercase. Chat channels live under `chats/`.
export const TEAM_FOLDERS = [
    'production',
    'marketing',
    'finance',
    'volunteers',
    'images',
    'branding',
    'chats',
] as const;
export type TeamFolder = (typeof TEAM_FOLDERS)[number];

// --- Threads: a chat channel, and the chat under a doc comment, a board card or a canvas comment ---

// A day counted back from the day of the seed, at a local time.
export type SeededTime = { daysAgo: number; hour: number; minute: number };

// One message of a thread. Its time is `gap` minutes after the message before, 2 when left out, or `at` when it
// opens a later day. A thread's first message takes the thread's start and neither of the two.
export type ChatLine = {
    author: string; // persona key
    text: string;
    // Seeded team documents, posted as drive references. The seeder resolves them to ids at seed time, so a document
    // can only be attached from content seeded after it.
    attach?: string[];
    attachVCards?: string[]; // VCARD_FILES names, uploaded into the chat's own media/ as a user's upload lands
    upload?: string[]; // fixture paths, uploaded into the chat's media/ the same way
    whisperTo?: string; // persona key: only they and the author read the text
    gap?: number;
    at?: SeededTime;
};

// A comment on one element of a canvas, such as a shape of the site plan or a chart on a slide.
export type CanvasComment = {
    card: string; // slug of the thread's chat name (lowercase, no extension)
    // The element's id without its `el-`: a shape's key, or a slide's key with the kind and number of what sits on it.
    element: string;
    title: string;
    author: string; // persona key
    text: string;
    start: SeededTime;
    replies?: ChatLine[];
};

// --- Documents (written as HTML, parsed by the editor's schema into each eigendoc) ---

export type DocComment = {
    // Slug used for the comment thread's chat name (lowercase, no extension).
    card: string;
    // Exact phrase from the doc text the comment mark anchors on (also the card title,
    // mirroring the editor's "title = selected text" convention).
    anchor: string;
    author: string; // persona key
    text: string;
    start: SeededTime;
    replies?: ChatLine[];
    assignTo?: LeadRole; // records an `assigned` activity + notification
    attach?: string[]; // seeded team documents pinned to the card
};

export type SeededDoc = {
    folder: TeamFolder;
    name: string; // lowercase, no extension
    author: LeadRole;
    html: string; // parsed into the eigendoc's JSON
    media?: string[]; // fixture paths under fixtures/, copied into the doc's media/ folder for its figures
    comments: DocComment[];
};

// A doc in each persona's own drive: no folder, author or comments.
export type PersonalDoc = Pick<SeededDoc, 'name' | 'html' | 'media'>;

// A displayed equation as the docs editor stores one: MathML with the typed LaTeX as its annotation, in a paragraph.
const displayedEquation = (latex: string) =>
    `<p>${writeMathml(readLatex(latex), latex).replace('<math', '<math display="block"')}</p>`;

export const DOCS: SeededDoc[] = [
    {
        folder: 'production',
        name: 'production plan',
        author: 'production',
        html: [
            '<h1>Production plan</h1>',
            '<p>Working document for this edition. Three weeks out. Line-up roughly 80% confirmed, tickets moving, still short on crew for the build weekend.</p>',
            '<h2>Site & access</h2>',
            '<p>The festival is on the Hoeve Tuimelaar field near Vlierzand, on the coast. Remote by design, which means we bring everything in: water, power, sanitation, and the people.</p>',
            '<ul><li>Shuttle buses from the nearest station, every 30 minutes<span class="footnote" data-type="footnote"><span data-type="footnote-paragraph">Duin Shuttle runs the loop. The last bus back leaves at 02:00.</span></span></li><li>Two generators plus a backup, quote pending</li><li>Camping field opens Friday midday</li></ul>',
            '<p><span class="figure"><img data-media-name="camping-field.webp" alt="The camping field with its new sign" width="420"><span class="figcaption">The camping field this week. The sign went up today.</span></span></p>',
            '<h2>Timeline</h2>',
            '<table><tbody>',
            '<tr><th>When</th><th>What</th><th>Who</th></tr>',
            '<tr><td>Build weekend</td><td>Fencing, stages, power</td><td>Production, site crew, volunteers</td></tr>',
            '<tr><td>Friday</td><td>Load-in and soundchecks</td><td>Stage & tech</td></tr>',
            '<tr><td>Saturday and Sunday</td><td>Doors at midday</td><td>Everyone</td></tr>',
            '<tr><td>Monday</td><td>Strike</td><td>Site crew</td></tr>',
            '</tbody></table>',
            '<h2>Power</h2>',
            "<p>Timo's sum for Saturday night, when everything runs at once:</p>",
            displayedEquation(
                '38 + 22 + 14 + 6 = 80\\,\\text{kW} \\le 2 \\times 60\\,\\text{kVA} \\times 0.8 = 96\\,\\text{kW}',
            ),
            '<p>Main stage 38, second stage 22, bar and food trucks 14, site light and camping 6. The backup gives 48 kW on its own, so it carries the second stage alone if a unit trips.</p>',
            '<h2>Responsibilities</h2>',
            '<p>Programming owns the line-up and stage times. Production owns the site and logistics. Volunteers owns the shift roster. Finance owns tickets and the budget. Comms owns the public info.</p>',
            '<h2>Open risks</h2>',
            '<p>The Sunday forecast for the exposed field looks rough. We decide on wind cover for the second stage at the go/no-go meeting.</p>',
        ].join(''),
        media: ['images/camping-field.webp'],
        comments: [
            {
                card: 'volunteers-gap',
                anchor: 'short on crew for the build weekend',
                author: 'saar',
                text: "We're still about 10 volunteers short for the build weekend. Can we push the call-out again?",
                start: { daysAgo: 5, hour: 9, minute: 40 },
                attach: ['crew roster'],
                replies: [
                    { author: 'nour', text: 'On it, sending a fresh call-out to the mailing list today.', gap: 18 },
                    { author: 'saar', text: '/highfive' },
                ],
                assignTo: 'volunteers',
            },
            {
                card: 'sunday-weather',
                anchor: 'wind cover for the second stage',
                author: 'timo',
                text: 'The Sunday forecast for the field looks rough. Do we tent the second stage?',
                start: { daysAgo: 6, hour: 17, minute: 5 },
                replies: [
                    {
                        author: 'saar',
                        text: "Let's decide at the go/no-go. Getting a quote for wind-rated cover.",
                        gap: 205,
                    },
                ],
            },
            {
                card: 'shuttle-timing',
                anchor: 'Shuttle buses from the nearest station',
                author: 'joris',
                text: 'Last shuttle at 01:00 or 02:00? It affects the closing set.',
                start: { daysAgo: 7, hour: 14, minute: 20 },
                replies: [{ author: 'mees', text: "02:00, I'll put it on the info page.", gap: 45 }],
            },
        ],
    },
    {
        folder: 'marketing',
        name: 'press release draft',
        author: 'comms',
        html: [
            '<h1>Press release draft</h1>',
            '<p><em>For release once the line-up hits 100%.</em></p>',
            '<p>Tuimel Festival returns to the coastal fields near Vlierzand for a weekend of emerging music, spoken word, installations and workshops. Small on purpose: two stages, a food corner, and camping under big skies.</p>',
            '<p>Tickets are on sale now. The full line-up reveal follows in the coming days.</p>',
        ].join(''),
        comments: [
            {
                card: 'headline',
                anchor: 'full line-up reveal',
                author: 'anouk',
                text: 'Can we lead with the line-up reveal date instead of the theme?',
                start: { daysAgo: 3, hour: 11, minute: 10 },
            },
        ],
    },
];

// --- Workbooks. Ranges are A1 text, and a chart's ranges name the tab they read. ---

// Text, a number, or a formula: a string that starts with '='. null leaves the cell empty.
export type SheetCellSpec = string | number | null;

// header: bold over a rule. section: an italic band on a fill over a rule. total: italic under a rule.
export type SheetRowSpec = { cells: SheetCellSpec[]; style?: 'header' | 'section' | 'total' };

export type SheetChartSpec = {
    type: 'column' | 'pie';
    title: string;
    seriesName: string;
    categories: string; // A1 with the tab, e.g. Budget!A4:A7
    values: string;
    x: number; // the chart's box on the grid, in pixels from A1
    y: number;
    size?: { width: number; height: number }; // Insert's default size when missing
};

export type SheetSpec = {
    name: string; // the tab
    columns: { width: number; format?: string }[]; // format: the Excel number format the column's numbers show in
    rows: SheetRowSpec[];
    dataBars?: string[]; // ranges drawn with a data bar
    redBelowZero?: string[]; // ranges whose cells turn red when they go below zero
    dropdowns?: { range: string; options: string[] }[];
    charts?: SheetChartSpec[];
};

const EUR = '_(€* #,##0.00_);_(€* (#,##0.00);_(€* "-"??_);_(@_)';
const BUDGET_STATUSES = ['confirmed', 'pending', 'paid'];

const BUDGET_COLUMNS = [{ width: 218 }, { width: 128, format: EUR }, { width: 110 }];

export const BUDGET = {
    folder: 'finance' as const satisfies TeamFolder,
    name: 'budget', // lowercase, no extension
    author: 'finance' as const satisfies LeadRole,
    sheets: [
        {
            name: 'Budget',
            columns: BUDGET_COLUMNS,
            rows: [
                { cells: ['Item', 'Amount (EUR)', 'Status'], style: 'header' },
                { cells: [] },
                { cells: ['Income'], style: 'section' },
                { cells: ['Ticket sales', 42000, 'pending'] },
                { cells: ['Bar', 9000, 'pending'] },
                { cells: ['Culture fund grant', 15000, 'confirmed'] },
                { cells: ['Local sponsors', 6000, 'paid'] },
                { cells: ['Total income', '=SUM(B4:B7)'], style: 'total' },
                { cells: [] },
                { cells: ['Costs'], style: 'section' },
                { cells: ['Artist fees', 28000, 'confirmed'] },
                { cells: ['Stage & tech', 12000, 'confirmed'] },
                { cells: ['Security', 6000, 'pending'] },
                { cells: ['Sanitation', 4000, 'paid'] },
                { cells: ['Shuttle buses', 3500, 'pending'] },
                { cells: ['Marketing', 2500, 'paid'] },
                { cells: ['Total costs', '=SUM(B11:B16)'], style: 'total' },
                { cells: ['Margin', '=B8-B17'], style: 'total' },
            ],
            dataBars: ['B4:B7', 'B11:B16'],
            redBelowZero: ['B18'],
            dropdowns: [
                { range: 'C4:C7', options: BUDGET_STATUSES },
                { range: 'C11:C16', options: BUDGET_STATUSES },
            ],
            charts: [
                {
                    type: 'column',
                    title: 'Costs',
                    seriesName: 'Amount (EUR)',
                    categories: 'Budget!A11:A16',
                    values: 'Budget!B11:B16',
                    // Beside the table and level with its top, small enough that both fit a 1000-pixel-wide page.
                    x: BUDGET_COLUMNS.reduce((sum, column) => sum + column.width, 0) + 24,
                    y: 0,
                    size: { width: 440, height: 320 },
                },
            ],
        },
        {
            name: 'Charts',
            columns: [],
            rows: [],
            charts: [
                {
                    type: 'pie',
                    title: 'Income',
                    seriesName: 'Amount (EUR)',
                    categories: 'Budget!A4:A7',
                    values: 'Budget!B4:B7',
                    x: 20,
                    y: 20,
                },
            ],
        },
    ] satisfies SheetSpec[],
};

// The quote Rob attaches to the generator thread (MAILS), sent as an xlsx.
export const GENERATOR_QUOTE: SheetSpec[] = [
    {
        name: 'Quote',
        columns: [{ width: 330 }, { width: 70 }, { width: 110, format: EUR }, { width: 120, format: EUR }],
        rows: [
            { cells: ['Item', 'Qty', 'Price', 'Total'], style: 'header' },
            { cells: ['Generator 60 kVA, Thursday to Monday', 2, 1240, '=B2*C2'] },
            { cells: ['Backup generator 60 kVA, Thursday to Monday', 1, 1040, '=B3*C3'] },
            { cells: ['Distribution boxes and cabling', 6, 85, '=B4*C4'] },
            { cells: ['Diesel, estimated litres', 900, 1.85, '=B5*C5'] },
            { cells: ['Delivery and pickup', 1, 450, '=B6*C6'] },
            { cells: ['Total excl. VAT', null, null, '=SUM(D2:D6)'], style: 'total' },
            { cells: ['VAT 21%', null, null, '=D7*0.21'] },
            { cells: ['Total incl. VAT', null, null, '=D7+D8'], style: 'total' },
        ],
    },
];

// --- Sponsor deck: one 1920x1080 frame per slide, elements placed from the frame's top-left corner. Slide keys
// are stable so element ids stay the same across reseeds. ---

// A text box, authored as the TipTap HTML the editor itself stores (paragraphs, <strong>, lists).
export type DeckText = {
    html: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontSize: number;
    font?: string; // an EIGEN_FONTS name; default the deck's Inter
    color?: string; // default the deck ink
    bold?: boolean;
    align?: TextAlign; // default left
    valign?: VerticalAlign; // default top
};

export type DeckImage = {
    file: string; // fixture path under fixtures/, uploaded into the container's media/ folder
    x: number;
    y: number;
    width: number;
    height: number;
};

// A chart of inline data, as Insert → Chart places one on a slide, with no title and no legend.
export type DeckChart = {
    type: ChartType;
    categories: string[];
    series: { name: string; values: number[]; color?: string }[]; // color: default the palette's
    x: number;
    y: number;
    width: number;
    height: number;
    font?: string; // an EIGEN_FONTS name; default the deck's Inter
};

// Drawn bottom-up: images, then charts, then every text on top.
export type DeckSlide = {
    key: string;
    name: string; // the slide's name in the rail
    background: FillPaint;
    texts: DeckText[];
    images?: DeckImage[];
    charts?: DeckChart[];
};

// The deck's ink: every text box that does not name its own color is built in this.
export const DECK_INK = '#111111';
// Body copy sits one shade back from the heading above it.
const DECK_MUTED = '#444444';
// Headings are hand-drawn, the way the festival's own signage is; body copy stays in the deck's Inter.
const DECK_HAND = 'Excalifont';
// The same sunrise behind every slide.
const DECK_BACKGROUND: FillPaint = { type: 'gradient', from: '#fff085', to: '#e17100', angle: 180 };
// Most slides after the title are one layout: a heading over a single line of body copy, both centered in a
// 1536px column. The place moves the two into a column beside its photo; the sponsors slide lifts them over a chart.
const DECK_HEADING = {
    x: 192,
    y: 340,
    width: 1536,
    height: 200,
    fontSize: 72,
    font: DECK_HAND,
    bold: true,
    align: 'center',
    valign: 'center',
} as const;
const DECK_BODY = {
    x: 192,
    y: 560,
    width: 1536,
    height: 180,
    fontSize: 40,
    color: DECK_MUTED,
    align: 'center',
    valign: 'center',
} as const;

export const SPONSOR_DECK = {
    folder: 'marketing' as const satisfies TeamFolder,
    name: 'sponsor pitch', // lowercase, no extension
    author: 'comms' as const satisfies LeadRole,
    slides: [
        {
            key: 'title',
            name: 'Title',
            background: DECK_BACKGROUND,
            // The festival mark between the title and the strapline, letterboxed inside its box.
            images: [{ file: 'branding/logo.svg', x: 706, y: 373, width: 509, height: 334 }],
            texts: [
                {
                    html: '<p>Tuimel Festival</p>',
                    x: 192,
                    y: 173,
                    width: 1536,
                    height: 200,
                    fontSize: 120,
                    font: DECK_HAND,
                    align: 'center',
                    valign: 'center',
                },
                {
                    ...DECK_BODY,
                    y: 765,
                    font: DECK_HAND,
                    html: '<p>A small coastal festival for emerging music and art</p>',
                },
            ],
        },
        {
            key: 'who-comes',
            name: 'Who comes',
            background: DECK_BACKGROUND,
            texts: [
                { ...DECK_HEADING, html: '<p>Who comes</p>' },
                {
                    ...DECK_BODY,
                    html: '<p>A couple thousand curious people, two stages, camping under big skies</p>',
                },
            ],
        },
        {
            key: 'the-place',
            name: 'The place',
            background: DECK_BACKGROUND,
            images: [{ file: 'images/dune-sunset.webp', x: 992, y: 190, width: 736, height: 552 }],
            texts: [
                { ...DECK_HEADING, x: 192, width: 720, html: '<p>The place</p>' },
                {
                    ...DECK_BODY,
                    x: 192,
                    width: 720,
                    html: '<p>A meadow behind the dunes at Hoeve Tuimelaar, five minutes from the sea</p>',
                },
            ],
        },
        {
            key: 'why-partner',
            name: 'Why partner with us',
            background: DECK_BACKGROUND,
            texts: [
                { ...DECK_HEADING, html: '<p>Why partner with us</p>' },
                {
                    ...DECK_BODY,
                    html: '<p>Warm, local, and independent: your name next to a much-loved weekend</p>',
                },
            ],
        },
        {
            key: 'what-you-get',
            name: 'What you get',
            background: DECK_BACKGROUND,
            texts: [
                { ...DECK_HEADING, html: '<p>What you get</p>' },
                {
                    ...DECK_BODY,
                    html: '<p>Stage credit, on-site presence, and a mention in every announcement</p>',
                },
            ],
        },
        {
            key: 'sponsors',
            name: "This year's sponsors",
            background: DECK_BACKGROUND,
            charts: [
                {
                    type: 'column',
                    categories: ['Friend', 'Partner', 'Stage partner'],
                    series: [{ name: 'Sponsors so far', values: [8, 2, 1], color: '#0084d1' }],
                    x: 460,
                    y: 330,
                    width: 1000,
                    height: 520,
                    font: DECK_HAND,
                },
            ],
            texts: [
                { ...DECK_HEADING, y: 120, height: 120, html: "<p>This year's sponsors</p>" },
                {
                    ...DECK_BODY,
                    y: 240,
                    height: 80,
                    html: '<p>Friend €250 · Partner €1,000 · Stage partner €2,000</p>',
                },
            ],
        },
        {
            key: 'lets-talk',
            name: "Let's talk",
            background: DECK_BACKGROUND,
            texts: [
                { ...DECK_HEADING, html: "<p>Let's talk</p>" },
                { ...DECK_BODY, html: '<p>Reach out to the crew and join this edition</p>' },
            ],
        },
    ] satisfies DeckSlide[],
    comments: [
        {
            card: 'sponsor-numbers',
            element: 'sponsors-chart-0',
            title: 'Sponsor numbers',
            author: 'bram',
            text: 'Numbers are from the budget: 8 friends, 2 partners, 1 stage partner. All paid.',
            start: { daysAgo: 2, hour: 10, minute: 20 },
            replies: [{ author: 'mees', text: "Thanks. I'll update it when the next one signs." }],
        },
    ] satisfies CanvasComment[],
};

// --- Stickies board fixture (authored once, byte-copied in) ---

export type CardSpec = {
    title: string;
    description: string;
    column: string; // must be one of KANBAN.columns
    creator: string; // persona key; domainised into an email by the seeder
    // The card's chat thread, as a DocComment has one: a chat in the board's chat/ subfolder, started by the creator
    // when the card was made.
    chat: string; // slug, lowercase, no extension
    chatText: string;
    start?: SeededTime; // left out, a day after the board per place in the list
    chatReplies?: ChatLine[];
    attach?: string[]; // seeded team documents pinned to the card
    cover?: string; // fixture path, uploaded into the board's media/; the card's first image attachment is its cover
    assignTo?: LeadRole; // by the board's author
    resolvedBy?: string; // persona key
};

export const KANBAN: { folder: TeamFolder; name: string; columns: string[]; cards: CardSpec[] } = {
    folder: 'production',
    name: 'festival kanban', // lowercase, no extension
    columns: ['to do', 'doing', 'done'],
    cards: [
        {
            title: 'Confirm headliner contract',
            description: 'Signed and countersigned.',
            column: 'done',
            creator: 'joris',
            chat: 'headliner-contract',
            chatText: 'Signed and countersigned today.',
            chatReplies: [
                { author: 'anouk', text: "Nice one, let's get it into the press release.", gap: 25 },
                { author: 'joris', text: '/cheer' },
            ],
        },
        {
            title: 'Order fencing',
            // Task-list HTML, so this card shows a checklist with a progress badge, which counts the
            // <li data-checked> items.
            description:
                '<ul data-type="taskList">' +
                '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Get quotes from two suppliers</p></div></li>' +
                '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Confirm build-weekend delivery slot</p></div></li>' +
                '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>Sign off on the final quote</p></div></li>' +
                '</ul>',
            column: 'doing',
            creator: 'saar',
            chat: 'fencing-order',
            chatText: 'Getting quotes in for the build-weekend delivery.',
            chatReplies: [
                {
                    author: 'timo',
                    text: 'See if they can drop it Thursday, we need the site clear before that.',
                    gap: 40,
                },
            ],
        },
        {
            title: 'Publish full line-up',
            description: 'Once the last two acts confirm.',
            column: 'to do',
            creator: 'mees',
            chat: 'lineup-publish',
            chatText: 'Holding this until the last two acts confirm.',
            chatReplies: [{ author: 'joris', text: 'Should have both locked in by Friday.', gap: 95 }],
        },
        {
            title: 'Recruit 10 more volunteers',
            description: 'Blocked on the call-out going out.',
            column: 'to do',
            creator: 'nour',
            chat: 'volunteer-recruit',
            chatText: 'Still about 10 short for the build weekend. Call-out goes out today.',
            start: { daysAgo: 5, hour: 10, minute: 15 },
            chatReplies: [{ author: 'anouk', text: 'Let me know if you want a hand drafting it.', gap: 30 }],
            assignTo: 'volunteers',
        },
        {
            title: 'Fix generator quote',
            description: 'Two generators plus a backup.',
            column: 'doing',
            creator: 'saar',
            chat: 'generator-quote',
            chatText: 'Chasing numbers for two generators plus a backup.',
            chatReplies: [
                {
                    author: 'timo',
                    text: 'Make sure the backup can carry the second stage on its own if it has to.',
                    gap: 50,
                },
            ],
            attach: ['site plan'],
        },
        {
            title: 'Print wristbands',
            description: 'Three tiers, camping included.',
            column: 'to do',
            creator: 'daan',
            chat: 'wristbands-print',
            chatText: 'Three tiers, camping included. Sending the design to print this week.',
            chatReplies: [{ author: 'anouk', text: "Nice, post a preview here when it's back.", gap: 20 }],
        },
        {
            title: 'Book shuttle buses',
            description: 'Every 30 minutes from the station.',
            column: 'done',
            creator: 'saar',
            chat: 'shuttle-buses',
            chatText: 'Booked. Every 30 minutes from the station.',
            chatReplies: [{ author: 'mees', text: "I'll put the schedule on the info page.", gap: 65 }],
            resolvedBy: 'saar',
        },
        {
            title: 'Sunday wind cover',
            description: 'Decide at the go/no-go meeting.',
            column: 'to do',
            creator: 'timo',
            chat: 'wind-cover',
            chatText: 'Forecast for the field is turning windy Sunday. Need a call on tenting the second stage.',
            chatReplies: [
                {
                    author: 'saar',
                    text: "Let's decide at the go/no-go, I'll get a wind-cover quote before then.",
                    gap: 35,
                },
                {
                    author: 'saar',
                    text: 'Quote is in from Dekzeil & Zo. They have a stage rain cover free that weekend, wind rated. Their card is attached if you want to talk sizes.',
                    attachVCards: ['dekzeil & zo.vcf'],
                    at: { daysAgo: 3, hour: 15, minute: 30 },
                },
            ],
            cover: 'images/storm-over-the-field.webp',
        },
    ],
};

// --- Site photos (committed .webp fixtures uploaded into the team drive's images/ folder) ---

export type PhotoSpec = {
    file: string; // fixture filename under fixtures/images/ (see CREDITS.md)
    caption: string; // in-world note describing the shot
    uploader: string; // persona key
};

export const PHOTOS: PhotoSpec[] = [
    { file: 'camping-field.webp', caption: 'Camping field is taking shape. The sign went up today.', uploader: 'yara' },
    {
        file: 'storm-over-the-field.webp',
        caption: 'Sky over the field last week. This is the Sunday weather I keep flagging.',
        uploader: 'timo',
    },
    {
        file: 'wildflower-meadow.webp',
        caption: 'The meadow by the entrance is in full bloom right now.',
        uploader: 'mees',
    },
    {
        file: 'beach-poles-sunset.webp',
        caption: 'Sunset five minutes from the field. One for the socials.',
        uploader: 'mees',
    },
    { file: 'dune-sunset.webp', caption: 'Dune and sea at golden hour, for the marketing set.', uploader: 'mees' },
    {
        file: 'crowd-arriving.webp',
        caption: 'Crowd arriving from last edition. Nice for the announcement.',
        uploader: 'mees',
    },
    {
        file: 'hands-up-at-camp.webp',
        caption: 'Camping mornings from last year. Still makes me smile.',
        uploader: 'mees',
    },
];

// --- Branding assets (committed fixtures uploaded into the team drive's branding/ folder) ---

export type BrandingAsset = {
    file: string; // fixture filename under fixtures/branding/
    mimeType: string;
    uploader: string; // persona key
};

export const BRANDING: BrandingAsset[] = [{ file: 'logo.svg', mimeType: 'image/svg+xml', uploader: 'mees' }];

// --- Contact cards: one spec shape for every vCard in the demo world. The seeder serializes it with the shipped
// createVCard, so a seeded card is what the app itself writes. ---

export type VCardSpec = {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    company?: string;
    jobTitle?: string;
    notes?: string;
    photo?: string; // fixture filename under fixtures/avatars/, embedded as the card's PHOTO
};

// A .vcf uploaded into the team drive like any other file. `name` doubles as the key a card chat reply's
// `attachVCards` uploads a copy under.
export type SeededVCardFile = {
    folder: TeamFolder;
    name: string; // lowercase, with the .vcf extension
    uploader: string; // persona key
    card: VCardSpec;
};

// The wind-cover supplier: his card in the team drive, and the same card in Saar's own book.
const RUUD_DEKKER: VCardSpec = {
    firstName: 'Ruud',
    lastName: 'Dekker',
    email: 'ruud@dekzeil-en-zo.example',
    phone: '+31 6 2244 8890',
    company: 'Dekzeil & Zo',
    jobTitle: 'Rentals',
    notes: 'Tarps and tents. Quoted the rain cover for the second stage.',
    photo: 'ruud.jpg',
};

// The fencing supplier, who writes to Ravi and Saar and sits in Saar's book. Saar shares the site plan with him, so
// he is the demo's one guest.
export const HEIN_KLARENBEEK = { name: 'Hein Klarenbeek', email: 'hein@hekwerkverhuur.example' };

export const VCARD_FILES: SeededVCardFile[] = [
    { folder: 'production', name: 'dekzeil & zo.vcf', uploader: 'saar', card: RUUD_DEKKER },
];

// --- Site plan. Scene units are pixels, y down, and a shape's label is its own text, centered in it. Shape keys
// are stable so arrows can bind to them by name. ---

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

// An arrow end: docked on a named shape's side (a real binding) or a free scene point.
// `along` (0..1) docks off-center on a rectangle side; default is the side midpoint.
export type SitePlanEnd = { shape: string; side: CanvasSide; along?: number } | { at: [number, number] };

export type SitePlanShape = {
    key: string;
    kind: 'rectangle' | 'ellipse' | 'diamond';
    label: string; // '' for an unlabelled outline; '\n' for a second line
    x: number;
    y: number;
    width: number;
    height: number;
    angle?: number; // degrees clockwise, default 0 (the label turns with it)
    fontSize?: number; // label size, default 16
    fill?: string; // default transparent
    fillStyle?: FillStyle; // default solid
    stroke?: string; // default DEFAULT_ELEMENT_PROPS.strokeColor
    strokeStyle?: StrokeStyle;
    strokeWidth?: number;
    corners?: Corners; // default curved
    ground?: boolean; // drawn beneath the lines too, for an outline that must never catch a click meant for what it encloses
};

export type SitePlanArrow = {
    from: SitePlanEnd;
    to: SitePlanEnd;
    elbow?: boolean;
    label?: string;
    labelSize?: number; // default 13
    stroke?: string;
    strokeStyle?: StrokeStyle;
    startHead?: Arrowhead; // default none
    endHead?: Arrowhead; // default arrow
};

export type SitePlanText = {
    text: string;
    x: number;
    y: number;
    fontSize: number;
    color?: string;
};

// A (poly)line in absolute scene points; `round` curves through the vertices.
export type SitePlanLine = {
    points: [number, number][];
    freedraw?: boolean; // a pen stroke instead of a line (roundness and strokeStyle ignored)
    stroke?: string;
    strokeWidth?: number;
    strokeStyle?: StrokeStyle;
    roundness?: Roundness; // default round
};

export type SitePlanImage = {
    file: string; // fixture path under fixtures/, copied into the container's media/ folder
    x: number;
    y: number;
    width: number;
    height: number;
};

const STAGE = { fill: '#ffd8a8', fillStyle: 'hachure', stroke: '#e8590c' } as const;
const BUILDING = { fill: '#e9ecef' } as const;
const NOTE = '#495057';

export const SITE_PLAN = {
    folder: 'production' as const satisfies TeamFolder,
    name: 'site plan', // lowercase, no extension
    author: 'production' as const satisfies LeadRole,
    background: '#fffbeb', // the scene's paper; the fence fill is the meadow on it
    // Drawn bottom-up: lines (ground), shapes, images, arrows, then every text on top.
    lines: [
        // The dune ridge sits a walk west of the fence, so it balances the photo-and-legend column on the east
        // side and puts the scene's center on the crowd-flow arrow.
        {
            points: [
                [-118, 150],
                [-100, 230],
                [-124, 310],
                [-98, 390],
                [-122, 470],
                [-98, 550],
                [-124, 630],
                [-98, 710],
                [-122, 790],
                [-104, 870],
            ],
            stroke: '#74c0fc',
        },
        // Three gusts blowing in on the second stage.
        {
            points: [
                [880, 262],
                [905, 254],
                [930, 262],
                [955, 254],
            ],
            stroke: '#adb5bd',
        },
        {
            points: [
                [880, 287],
                [905, 279],
                [930, 287],
                [955, 279],
            ],
            stroke: '#adb5bd',
        },
        {
            points: [
                [880, 312],
                [905, 304],
                [930, 312],
                [955, 304],
            ],
            stroke: '#adb5bd',
        },
        // The art trail winding from the workshops to the camping field, drawn by hand.
        {
            points: [
                [365, 790],
                [394, 795],
                [423, 794],
                [451, 801],
                [480, 802],
                [509, 801],
                [538, 803],
                [567, 809],
                [595, 807],
                [624, 802],
                [653, 804],
                [682, 799],
                [710, 795],
                [740, 796],
                [768, 790],
                [797, 792],
                [826, 786],
                [854, 780],
                [883, 779],
                [911, 771],
                [940, 770],
                [969, 768],
                [991, 755],
                [1003, 728],
                [1010, 700],
            ],
            freedraw: true,
            stroke: '#9c36b5',
        },
    ] satisfies SitePlanLine[],
    shapes: [
        {
            key: 'fence',
            kind: 'rectangle',
            label: '',
            x: 120,
            y: 150,
            width: 1180,
            height: 720,
            fill: '#ecfcca',
            stroke: '#868e96',
            strokeStyle: 'dashed',
            ground: true,
        },
        {
            key: 'crew-cabin',
            kind: 'rectangle',
            label: 'Crew cabin',
            x: 170,
            y: 180,
            width: 110,
            height: 45,
            fontSize: 14,
            ...BUILDING,
        },
        {
            key: 'farmhouse',
            kind: 'rectangle',
            angle: 3,
            label: 'Farmhouse, off limits',
            x: 295,
            y: 180,
            width: 180,
            height: 45,
            fontSize: 13,
            ...BUILDING,
        },
        {
            key: 'backstage',
            kind: 'rectangle',
            label: 'Backstage & hospitality',
            x: 520,
            y: 175,
            width: 220,
            height: 50,
            fontSize: 13,
            ...BUILDING,
        },
        {
            key: 'main-stage',
            kind: 'rectangle',
            label: 'Main stage',
            x: 540,
            y: 255,
            width: 300,
            height: 100,
            fontSize: 24,
            ...STAGE,
        },
        {
            key: 'foh',
            kind: 'rectangle',
            label: 'FOH',
            x: 600,
            y: 480,
            width: 60,
            height: 36,
            fontSize: 12,
            ...BUILDING,
        },
        {
            key: 'barn-stage',
            kind: 'rectangle',
            angle: -4,
            label: 'Barn stage\n(the old barn)',
            x: 170,
            y: 250,
            width: 200,
            height: 110,
            fontSize: 18,
            ...STAGE,
            fillStyle: 'cross-hatch',
            corners: 'straight',
        },
        {
            key: 'wind-cover',
            kind: 'ellipse',
            label: '',
            x: 970,
            y: 238,
            width: 280,
            height: 136,
            stroke: '#e03131',
            strokeStyle: 'dashed',
        },
        {
            key: 'second-stage',
            kind: 'rectangle',
            label: 'Second stage',
            x: 1000,
            y: 260,
            width: 220,
            height: 90,
            fontSize: 20,
            ...STAGE,
        },
        { key: 'g1', kind: 'diamond', label: 'G1', x: 760, y: 160, width: 84, height: 60, fontSize: 13, ...BUILDING },
        { key: 'g2', kind: 'diamond', label: 'G2', x: 1000, y: 160, width: 84, height: 60, fontSize: 13, ...BUILDING },
        {
            key: 'g-backup',
            kind: 'diamond',
            label: 'backup',
            x: 1120,
            y: 160,
            width: 84,
            height: 60,
            fontSize: 12,
            ...BUILDING,
        },
        {
            key: 'workshops',
            kind: 'ellipse',
            label: 'Workshops\n& kids',
            x: 185,
            y: 735,
            width: 180,
            height: 100,
            fill: '#d0bfff',
        },
        {
            key: 'bar-tent',
            kind: 'ellipse',
            label: 'Bar tent',
            x: 180,
            y: 470,
            width: 180,
            height: 90,
            fontSize: 18,
            fill: '#a5d8ff',
        },
        {
            key: 'food',
            kind: 'rectangle',
            label: 'Food trucks',
            x: 760,
            y: 430,
            width: 200,
            height: 80,
            fontSize: 18,
            fill: '#ffec99',
        },
        {
            key: 'water',
            kind: 'ellipse',
            label: 'Water',
            x: 985,
            y: 420,
            width: 90,
            height: 50,
            fontSize: 14,
            fill: '#a5d8ff',
        },
        {
            key: 'toilets-a',
            kind: 'rectangle',
            label: 'Toilets',
            x: 215,
            y: 595,
            width: 110,
            height: 45,
            fontSize: 14,
            ...BUILDING,
        },
        {
            key: 'toilets-b',
            kind: 'rectangle',
            label: 'Toilets',
            x: 1120,
            y: 420,
            width: 110,
            height: 45,
            fontSize: 14,
            ...BUILDING,
        },
        {
            key: 'waste',
            kind: 'rectangle',
            label: 'Waste & bins',
            x: 760,
            y: 560,
            width: 130,
            height: 45,
            fontSize: 14,
            fill: '#b2f2bb',
        },
        {
            key: 'first-aid',
            kind: 'rectangle',
            label: 'First aid',
            x: 430,
            y: 690,
            width: 110,
            height: 50,
            fill: '#ffc9c9',
            stroke: '#e03131',
        },
        {
            key: 'info',
            kind: 'rectangle',
            label: 'Info & lost+found',
            x: 830,
            y: 690,
            width: 150,
            height: 50,
            fontSize: 13,
            ...BUILDING,
        },
        {
            key: 'gate',
            kind: 'rectangle',
            label: 'Gate & wristbands',
            x: 560,
            y: 840,
            width: 260,
            height: 60,
            fontSize: 18,
            fill: '#b2f2bb',
        },
        {
            key: 'box-office',
            kind: 'rectangle',
            label: 'Box office',
            x: 380,
            y: 890,
            width: 150,
            height: 50,
            ...BUILDING,
        },
        {
            key: 'meadow',
            kind: 'ellipse',
            label: 'Meadow, in bloom',
            x: 860,
            y: 895,
            width: 230,
            height: 70,
            fontSize: 14,
            fill: '#b2f2bb',
            fillStyle: 'zigzag',
            stroke: '#2f9e44',
        },
        {
            key: 'shuttle',
            kind: 'rectangle',
            label: 'Shuttle stop',
            x: 600,
            y: 1000,
            width: 180,
            height: 50,
            ...BUILDING,
        },
        {
            key: 'parking',
            kind: 'rectangle',
            label: 'Parking\n(crew & artists)',
            x: 170,
            y: 900,
            width: 190,
            height: 110,
            fontSize: 14,
            ...BUILDING,
            fillStyle: 'cross-hatch',
        },
        { key: 'camping', kind: 'rectangle', label: '', x: 1010, y: 520, width: 270, height: 330, fill: '#b2f2bb' },
        {
            key: 'camping-desk',
            kind: 'rectangle',
            label: 'Camping host desk',
            x: 1030,
            y: 770,
            width: 170,
            height: 45,
            fontSize: 13,
            ...BUILDING,
        },
        // A polaroid of the camping field pinned next to it.
        {
            key: 'polaroid',
            kind: 'rectangle',
            label: '',
            x: 1330,
            y: 540,
            width: 220,
            height: 206,
            fill: '#ffffff',
            corners: 'straight',
        },
        // Legend swatches.
        {
            key: 'legend-stage',
            kind: 'rectangle',
            label: '',
            x: 1330,
            y: 805,
            width: 14,
            height: 14,
            ...STAGE,
            strokeWidth: 1,
        },
        {
            key: 'legend-drinks',
            kind: 'rectangle',
            label: '',
            x: 1330,
            y: 825,
            width: 14,
            height: 14,
            fill: '#a5d8ff',
            strokeWidth: 1,
        },
        {
            key: 'legend-green',
            kind: 'rectangle',
            label: '',
            x: 1330,
            y: 845,
            width: 14,
            height: 14,
            fill: '#b2f2bb',
            strokeWidth: 1,
        },
        {
            key: 'legend-aid',
            kind: 'rectangle',
            label: '',
            x: 1330,
            y: 865,
            width: 14,
            height: 14,
            fill: '#ffc9c9',
            stroke: '#e03131',
            strokeWidth: 1,
        },
    ] satisfies SitePlanShape[],
    images: [
        { file: 'branding/logo.svg', x: 20, y: 940, width: 96, height: 63 },
        { file: 'images/camping-field.webp', x: 1340, y: 550, width: 200, height: 150 },
    ] satisfies SitePlanImage[],
    arrows: [
        // Power runs from the generators; the backup can carry the second stage on its own.
        { from: { shape: 'g1', side: 'bottom' }, to: { shape: 'main-stage', side: 'top', along: 0.87 }, elbow: true },
        { from: { shape: 'g2', side: 'bottom' }, to: { shape: 'second-stage', side: 'top', along: 0.19 }, elbow: true },
        {
            from: { shape: 'g-backup', side: 'bottom' },
            to: { shape: 'second-stage', side: 'top', along: 0.74 },
            elbow: true,
            strokeStyle: 'dashed',
        },
        // How people arrive and spread out.
        {
            from: { shape: 'shuttle', side: 'top' },
            to: { shape: 'gate', side: 'bottom' },
            label: 'every 30 min, last bus 02:00',
        },
        {
            from: { shape: 'gate', side: 'top' },
            to: { shape: 'main-stage', side: 'bottom' },
            strokeStyle: 'dashed',
            stroke: '#868e96',
            label: 'crowd flow',
        },
        {
            from: { shape: 'gate', side: 'right', along: 0.25 },
            to: { shape: 'camping', side: 'left', along: 0.9 },
            strokeStyle: 'dashed',
            stroke: '#868e96',
        },
        { from: { shape: 'polaroid', side: 'left' }, to: { shape: 'camping', side: 'right', along: 0.37 } },
        // North.
        { from: { at: [1307, 126] }, to: { at: [1293, 72] }, endHead: 'triangle' },
    ] satisfies SitePlanArrow[],
    texts: [
        { text: 'Tuimel Festival site plan', x: 120, y: 40, fontSize: 36 },
        {
            text: 'Hoeve Tuimelaar, Vlierzand. Based on last year, to check and make final at the site visit. Not to scale, obviously.',
            x: 120,
            y: 92,
            fontSize: 16,
            color: '#868e96',
        },
        { text: 'N', x: 1283, y: 40, fontSize: 20 },
        { text: 'dunes, sea 5 min', x: -170, y: 120, fontSize: 14, color: '#4dabf7' },
        {
            text: 'Power: 2 x 60kVA + a backup that runs the second stage alone (delivery Thu)',
            x: 760,
            y: 128,
            fontSize: 12,
            color: NOTE,
        },
        { text: 'quieter acts here if Sunday blows (Sanne)', x: 170, y: 368, fontSize: 13, color: NOTE },
        { text: 'wind cover? decide at go/no-go', x: 985, y: 380, fontSize: 13, color: '#e03131' },
        { text: 're-peg either way, site crew is ready (Ravi)', x: 985, y: 400, fontSize: 12, color: NOTE },
        { text: 'art trail (Sem)', x: 590, y: 776, fontSize: 13, color: '#9c36b5' },
        { text: 'wind, Sunday?', x: 872, y: 320, fontSize: 12, color: '#868e96' },
        { text: 'extra bins come with the fencing (Lars)', x: 760, y: 612, fontSize: 12, color: NOTE },
        { text: 'covered both days, one gap Sunday morning (Imke)', x: 410, y: 745, fontSize: 12, color: NOTE },
        { text: '3 wristband tiers (Daan)', x: 705, y: 905, fontSize: 13, color: NOTE },
        { text: 'Camping field', x: 1030, y: 535, fontSize: 24 },
        { text: 'opens Friday midday', x: 1030, y: 575, fontSize: 13, color: NOTE },
        { text: 'quiet after 02:00', x: 1030, y: 596, fontSize: 13, color: NOTE },
        { text: 'the sign went up today (Yara)', x: 1340, y: 708, fontSize: 13 },
        { text: 'Legend', x: 1330, y: 780, fontSize: 14 },
        { text: 'stages', x: 1352, y: 803, fontSize: 12, color: NOTE },
        { text: 'drinks & water', x: 1352, y: 823, fontSize: 12, color: NOTE },
        { text: 'camping, gate & meadow', x: 1352, y: 843, fontSize: 12, color: NOTE },
        { text: 'first aid', x: 1352, y: 863, fontSize: 12, color: NOTE },
    ] satisfies SitePlanText[],
    comments: [
        {
            card: 'wind-cover-footprint',
            element: 'wind-cover',
            title: 'Wind cover footprint',
            author: 'timo',
            text: 'If we tent it, the red line is the room it needs. Ruud wants 3 m clear on every side for the guy lines.',
            start: { daysAgo: 2, hour: 15, minute: 20 },
            replies: [
                {
                    author: 'saar',
                    text: "Fits, just. The toilets on that side may have to shift a little. I'll pace it out on the site visit.",
                },
                { author: 'timo', text: '/highfive' },
            ],
        },
    ] satisfies CanvasComment[],
};

// --- Chat channels (real chat rooms in chats/, seeded via ChatRoom.postMessage as personas) ---

export type SeededChat = { name: string; start: SeededTime; messages: ChatLine[] };

export const CHATS: SeededChat[] = [
    {
        name: 'production',
        start: { daysAgo: 8, hour: 9, minute: 12 },
        messages: [
            { author: 'saar', text: 'Build weekend plan is up in the drive. Shout if a slot clashes.' },
            { author: 'timo', text: 'Power run looks fine. One generator quote still open.', gap: 28 },
            {
                author: 'daan',
                text: 'Wristbands ordered. Three tiers, camping included.',
                at: { daysAgo: 7, hour: 11, minute: 30 },
            },
            {
                author: 'timo',
                text: 'Heads up: the Sunday forecast for the field is turning windy.',
                at: { daysAgo: 6, hour: 16, minute: 48 },
            },
            { author: 'saar', text: 'How bad? The second stage is the exposed one.', gap: 3 },
            {
                author: 'timo',
                text: 'Gusts into the evening. No shelter out there right now.',
                upload: ['images/storm-over-the-field.webp'],
            },
            { author: 'saar', text: '/groan', gap: 0 },
            { author: 'sanne', text: 'we could move the quieter acts to the barn stage sunday?', gap: 27 },
            {
                author: 'anouk',
                text: "Let's keep the option open and decide at the go/no-go. Get a wind-cover quote.",
                gap: 175,
            },
            { author: 'saar', text: 'On it. Will have numbers before the meeting.', gap: 7 },
            {
                author: 'ravi',
                text: 'Site crew can re-peg the second stage either way. Ready for both.',
                at: { daysAgo: 5, hour: 8, minute: 5 },
            },
            { author: 'timo', text: '/highfive', gap: 15 },
            {
                author: 'saar',
                text: 'Site plan draft is up, based on last year. We walk it on the site visit and make it final after. Timo, check the generator runs. Fenna, the bar tent moved next to the food trucks.',
                attach: ['site plan'],
                at: { daysAgo: 2, hour: 14, minute: 40 },
            },
            { author: 'fenna', text: 'Closer to the food, closer to the queue. Fine by me.', gap: 22 },
            {
                author: 'timo',
                text: 'Runs look right. The backup on the second stage is exactly what Rob confirmed.',
                gap: 88,
            },
        ],
    },
    {
        name: 'volunteers',
        start: { daysAgo: 5, hour: 10, minute: 5 },
        messages: [
            { author: 'nour', text: "We're about 10 short for the build weekend. Pushing the call-out today." },
            { author: 'maud', text: 'i can bring two friends for load-in thursday', gap: 35 },
            { author: 'maud', text: '*friday', gap: 1 },
            { author: 'nour', text: 'Nice, added you three to the roster.', attach: ['crew roster'], gap: 34 },
            {
                author: 'nour',
                text: 'What are your friends called? The roster just says Maud plus two.',
                whisperTo: 'maud',
                gap: 0,
            },
            { author: 'maud', text: '/allthethings', gap: 1 },
            {
                author: 'yara',
                text: 'Camping host desk needs one more for the night shift.',
                at: { daysAgo: 4, hour: 9, minute: 30 },
            },
            { author: 'imke', text: 'First aid is covered for both days, one gap Sunday morning.', gap: 220 },
            { author: 'nour', text: "I'll flag the Sunday morning gap in the call-out.", gap: 15 },
            {
                author: 'lars',
                text: 'Waste team is set. Extra bins arrive with the fencing.',
                at: { daysAgo: 3, hour: 8, minute: 45 },
            },
            {
                author: 'pieter',
                text: 'Box office wants two runners at peak. Any takers?',
                at: { daysAgo: 2, hour: 17, minute: 30 },
            },
            { author: 'maud', text: '/me puts both hands up' },
            { author: 'maud', text: 'Put me down as a runner for Saturday peak.', gap: 30 },
            {
                author: 'nour',
                text: 'Thanks all. Roster is looking a lot healthier.',
                at: { daysAgo: 1, hour: 9, minute: 20 },
            },
            { author: 'maud', text: '/cheer', gap: 1 },
        ],
    },
];

// --- Mail (raw RFC822 delivered into persona inboxes; dates spread over the past ~10 days) ---

// An attachment on a seeded message: committed fixture bytes, a vCard the seeder serializes with the shipped writer,
// or a workbook it writes as an xlsx with the shipped exporter. Each lands as a real MIME attachment.
export type MailAttachment = { filename: string } & (
    | { fixture: string; mimeType: string } // path under fixtures/
    | { vcard: VCardSpec }
    | { workbook: SheetSpec[] }
);

// An iMIP invitation (METHOD:REQUEST) from the message's external sender to the thread's persona, written with the
// shipped iCalendar writer.
export type SeededInvite = Omit<SeededSlot, 'allDay' | 'days' | 'rrule'>;

export type SeededMail = {
    // 'inbox-thread' lands in one persona's inbox; 'all-hands' lands in every persona's inbox. Either
    // way the messages form one thread: one Message-ID per message, later ones replying to it.
    kind: 'inbox-thread' | 'all-hands';
    to?: LeadRole | string; // required for inbox-thread; role or persona key (mirrors EVENTS.attendees)
    subject: string;
    // Appends an "Open festival →" drive-reference pill to this mail's HTML body at seed time,
    // linking the shared team drive (the pathId is only known at runtime). Requires a message html.
    attachTeamDrive?: boolean;
    messages: {
        fromExternal?: { name: string; email: string }; // else `from` names the sender
        from?: string; // lead role or persona key (mirrors EVENTS.attendees)
        daysAgo: number;
        hour: number;
        text: string;
        // Optional rich body — the mail client renders real paragraphs/lists, not just plain text.
        // `text` stays as the plain-text fallback (multipart/alternative) when this is set.
        html?: string;
        attachments?: MailAttachment[];
        // Seeded team documents, linked as pills and shared read-only with the outside party, as a send does when
        // the sender grants access. Only on a persona's message to an external party.
        attachDocs?: string[];
        invite?: SeededInvite; // only on a message from an external sender
    }[];
};

export const MAILS: SeededMail[] = [
    {
        kind: 'inbox-thread',
        to: 'programming',
        subject: 'Tuimel Festival booking',
        messages: [
            {
                fromExternal: { name: 'Wolf Nachtlicht', email: 'wolf@nachtlicht-bookings.example' },
                daysAgo: 9,
                hour: 10,
                text: 'Hi Joris,\n\nThanks for the invite. The band would love to play Tuimel. Saturday works best for us. Could you confirm the fee and the stage times?\n\nBest,\nWolf',
            },
            {
                from: 'joris',
                daysAgo: 8,
                hour: 16,
                text: 'Hi Wolf,\n\nSaturday works for us too, glad that is settled. Fee as discussed, half on signing. Stage times land next week once the grid is locked. Sending the contract shortly.\n\nJoris',
            },
            {
                fromExternal: { name: 'Wolf Nachtlicht', email: 'wolf@nachtlicht-bookings.example' },
                daysAgo: 7,
                hour: 9,
                text: 'Sounds good, thanks Joris. We will watch for the contract. One question: is there a backline on the second stage or do we bring our own?\n\nWolf',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'director',
        subject: 'Are you doing it again this year',
        messages: [
            {
                fromExternal: { name: 'Tom Rovers', email: 'tom.rovers@example.com' },
                daysAgo: 8,
                hour: 21,
                text: 'Hi Anouk,\n\nSaw the posters going up near the station. Are you all doing Tuimel again this year? Would love to come back, it was the best weekend of last summer.\n\nTom',
            },
            {
                from: 'anouk',
                daysAgo: 8,
                hour: 22,
                text: 'Hi Tom,\n\nWe are, three weeks out now. Tickets are up on the site, hope to see you on the field again.\n\nAnouk',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'production',
        subject: 'Generator quote',
        messages: [
            {
                fromExternal: { name: 'Rob Tempel', email: 'rob@vlierkracht-verhuur.example' },
                daysAgo: 6,
                hour: 11,
                text: 'Hi Saar,\n\nQuote attached for two 60kVA units plus a backup. We can deliver Thursday morning, pickup Monday. Let me know if the dates work.\n\nRob\nVlierkracht Verhuur',
                attachments: [{ filename: 'vlierkracht quote.xlsx', workbook: GENERATOR_QUOTE }],
            },
            {
                from: 'saar',
                daysAgo: 6,
                hour: 15,
                text: 'Hi Rob,\n\nThursday works. Can the backup run the second stage on its own if the main unit trips? Timo will want to know before we sign off.\n\nSaar',
            },
            {
                fromExternal: { name: 'Rob Tempel', email: 'rob@vlierkracht-verhuur.example' },
                daysAgo: 5,
                hour: 9,
                text: 'Yes, the backup is rated for a full stage on its own. Sending the contract now.\n\nRob',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'comms',
        subject: 'Line-up reveal',
        messages: [
            {
                fromExternal: { name: 'Sanne Post', email: 'sanne@kustkrant.example' },
                daysAgo: 4,
                hour: 13,
                text: 'Hi Mees,\n\nWe would love to run something on the line-up reveal for the weekend edition. Deadline is Wednesday, any chance you can send a draft before then?\n\nSanne\nKustkrant',
            },
            {
                from: 'mees',
                daysAgo: 3,
                hour: 10,
                text: 'Hi Sanne,\n\nWe are two acts away from the full line-up, should land by Friday. I will send you the draft as soon as it is locked, before Wednesday if I can.\n\nMees',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'volunteers',
        subject: 'Volunteering this weekend',
        messages: [
            {
                fromExternal: { name: 'Femke Aarts', email: 'femke.aarts@example.com' },
                daysAgo: 3,
                hour: 19,
                text: 'Hi,\n\nSaw the call-out from a friend. I am free the whole build weekend and Saturday of the festival. Happy to help wherever needed.\n\nFemke',
            },
            {
                from: 'nour',
                daysAgo: 3,
                hour: 20,
                text: 'Hi Femke,\n\nThat is a big help, thank you. Put you down for build weekend and Saturday gate duty, I will send the schedule closer to the time.\n\nNour',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'finance',
        subject: 'Grant paperwork',
        messages: [
            {
                fromExternal: { name: 'Marijke Veen', email: 'marijke@cultuurfonds-kust.example' },
                daysAgo: 5,
                hour: 10,
                text: 'Hi Bram,\n\nAhead of our call, could you send the updated budget and the visitor estimate? We need both for the committee.\n\nMarijke\nCultuurfonds Kust',
            },
            {
                from: 'bram',
                daysAgo: 4,
                hour: 16,
                text: 'Hi Marijke,\n\nBudget is attached. Estimating around two thousand visitors across the weekend, similar to last edition. See you at the call.\n\nBram',
                attachments: [{ filename: 'tuimel budget.xlsx', workbook: BUDGET.sheets }],
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'finance',
        subject: 'Committee visit to the field',
        messages: [
            {
                fromExternal: { name: 'Marijke Veen', email: 'marijke@cultuurfonds-kust.example' },
                daysAgo: 2,
                hour: 11,
                text: 'Hi Bram,\n\nThe committee would like to see the field before the festival. I have sent an invitation for a short walk-through with the farmer. Let me know if the time works for you and Anouk.\n\nMarijke\nCultuurfonds Kust',
                invite: {
                    title: 'Cultuurfonds Kust: walk-through of the field',
                    daysFromFestival: -9,
                    startHour: 14,
                    durationHours: 1,
                    location: 'Hoeve Tuimelaar, Vlierzand',
                    description: 'The committee walks the field with Griet before the grant is paid out.',
                },
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'tech',
        subject: 'Backline second stage',
        messages: [
            {
                fromExternal: { name: 'Jasper Cools', email: 'jasper@geluidsploeg.example' },
                daysAgo: 4,
                hour: 9,
                text: 'Hi Timo,\n\nCan confirm a backline for the second stage: drums, two guitar amps, a bass rig. Same crew that did the barn last year.\n\nJasper\nGeluidsploeg',
            },
            {
                from: 'timo',
                daysAgo: 4,
                hour: 14,
                text: 'Hi Jasper,\n\nGood timing, one of the headliners just asked about exactly that. I will pass the specs along. Can you be on-site Friday for load-in?\n\nTimo',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'liaison',
        subject: 'Quiet room for Wolf',
        messages: [
            {
                fromExternal: { name: 'Nadia Roos', email: 'nadia@wolfpack-management.example' },
                daysAgo: 3,
                hour: 12,
                text: 'Hi Lieke,\n\nWolf needs a quiet room before the set, ideally somewhere out of the wind. Vegetarian catering is fine, nothing fancy.\n\nNadia\nWolfpack Management',
            },
            {
                from: 'lieke',
                daysAgo: 3,
                hour: 17,
                text: 'Hi Nadia,\n\nWe have a small back room behind the stage that should do. Catering is sorted. See you at load-in.\n\nLieke',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'fenna',
        subject: 'Bar delivery',
        messages: [
            {
                fromExternal: { name: 'Bo Reijn', email: 'bo@brouwerij-vlier.example' },
                daysAgo: 5,
                hour: 14,
                text: 'Hi Fenna,\n\nDelivery is set for Friday afternoon: the usual kegs plus the extra crate of soft drinks you asked for. Let me know if the gate needs a heads-up.\n\nBo\nBrouwerij Vlier',
            },
            {
                from: 'fenna',
                daysAgo: 5,
                hour: 16,
                text: 'Hi Bo,\n\nFriday works, I will let the gate know a van is coming in. Thanks for sorting the extra crate.\n\nFenna',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'daan',
        subject: 'Wristband print run',
        messages: [
            {
                fromExternal: { name: 'Print shop', email: 'orders@drukkerij-vlierzand.example' },
                daysAgo: 4,
                hour: 10,
                text: 'Hi Daan,\n\nDesign received, three tiers as discussed. Print run will be ready for pickup Wednesday.\n\nDrukkerij Vlierzand',
            },
            {
                from: 'daan',
                daysAgo: 4,
                hour: 11,
                text: 'Thanks, I will swing by Wednesday afternoon. Can you double-check the camping tier is the blue one? Last year it printed green.\n\nDaan',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'ravi',
        subject: 'Fencing delivery',
        messages: [
            {
                fromExternal: HEIN_KLARENBEEK,
                daysAgo: 6,
                hour: 8,
                text: 'Hi Ravi,\n\nFencing is loaded and coming Thursday, same as last year. Where do you want the pallets dropped this time?\n\nHein\nHekwerkverhuur Vlierzand',
            },
            {
                from: 'ravi',
                daysAgo: 6,
                hour: 13,
                text: 'Hi Hein,\n\nDrop them by the north track this year, closer to where we are building. Saar can meet you there.\n\nRavi',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'production',
        subject: 'Site plan for the fencing drop',
        messages: [
            {
                from: 'saar',
                daysAgo: 5,
                hour: 9,
                text: 'Hi Hein,\n\nRavi tells me the pallets go by the north track this year. I have shared our site plan with you so you can see where the fence line runs. The link is below, it opens in your browser.\n\nI will be at the track from eight on Thursday.\n\nSaar',
                attachDocs: [SITE_PLAN.name],
            },
            {
                fromExternal: HEIN_KLARENBEEK,
                daysAgo: 5,
                hour: 12,
                text: 'Hi Saar,\n\nThanks, that helps. I see the gate sits on the south side, so we will stack the gate panels apart from the rest. See you Thursday.\n\nHein\nHekwerkverhuur Vlierzand',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'imke',
        subject: 'Sunday morning shift',
        messages: [
            {
                fromExternal: { name: 'Willem de Boer', email: 'willem.deboer@example.com' },
                daysAgo: 2,
                hour: 20,
                text: 'Hi Imke,\n\nHeard first aid still needs someone Sunday morning. I did the course last year, happy to cover it if you still need someone.\n\nWillem',
            },
            {
                from: 'imke',
                daysAgo: 2,
                hour: 21,
                text: 'Hi Willem,\n\nThat would fill the last gap, thank you. Sunday 8 to 12, I will send the kit list closer to the time.\n\nImke',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'yara',
        subject: 'Camping field toilets',
        messages: [
            {
                fromExternal: { name: 'Sanitair Kust', email: 'planning@sanitairkust.example' },
                daysAgo: 5,
                hour: 9,
                text: 'Hi Yara,\n\nConfirming four units for the camping field, placed Friday morning, serviced once during the weekend.\n\nSanitair Kust',
            },
            {
                from: 'yara',
                daysAgo: 5,
                hour: 12,
                text: 'Hi,\n\nFriday morning works, before campers start arriving at midday. Can the service happen early Sunday, before it gets busy?\n\nYara',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'pieter',
        subject: 'Box office scanners',
        messages: [
            {
                fromExternal: { name: 'Ticketing support', email: 'support@ticketflow.example' },
                daysAgo: 3,
                hour: 15,
                text: 'Hi Pieter,\n\nYour two scanners are shipped, tracking attached. They come pre-loaded with the guest list, just charge them the night before.\n\nTicketFlow Support',
            },
            {
                from: 'pieter',
                daysAgo: 3,
                hour: 18,
                text: 'Thanks, will do. Does the offline mode still work if the field has no signal? Last year we lost it for an hour.\n\nPieter',
            },
        ],
    },
    {
        kind: 'inbox-thread',
        to: 'sem',
        subject: 'Installation on the dune path',
        messages: [
            {
                fromExternal: { name: 'Iris Bergman', email: 'iris.bergman@example.com' },
                daysAgo: 4,
                hour: 16,
                text: 'Hi Sem,\n\nI can bring the driftwood piece we talked about, it just needs a spot that will not flood if it rains. The dune path near the entrance still open?\n\nIris',
            },
            {
                from: 'sem',
                daysAgo: 4,
                hour: 19,
                text: 'Hi Iris,\n\nYes, that spot is still free and it sits high enough. Bring it Friday and we will find the exact angle together.\n\nSem',
            },
        ],
    },
    {
        kind: 'all-hands',
        subject: 'Logo in vector format',
        messages: [
            {
                from: 'comms',
                daysAgo: 3,
                hour: 9,
                text: 'Hi all,\n\nMy friend Mark redrew our logo as an SVG. Same logo, just properly in vector now.\n\nPlease use this one from now on: posters, the website, the sponsor deck. It stays sharp at any size, so no more fuzzy edges on a big print.\n\nIt is attached here, and it also lives in branding/ on the team drive.\n\nMees',
                html: '<p>Hi all,</p><p>My friend Mark redrew our logo as an SVG. Same logo, just properly in vector now.</p><p>Please use this one from now on:</p><ul><li>posters</li><li>the website</li><li>the sponsor deck</li></ul><p>It stays sharp at any size, so no more fuzzy edges on a big print. It is attached here, and it also lives in <strong>branding/</strong> on the team drive.</p><p>Mees</p>',
                attachments: [{ filename: 'logo.svg', fixture: 'branding/logo.svg', mimeType: 'image/svg+xml' }],
            },
        ],
    },
    {
        kind: 'all-hands',
        subject: 'Three weeks out',
        attachTeamDrive: true,
        messages: [
            {
                from: 'director',
                daysAgo: 2,
                hour: 8,
                text: "Hi everyone,\n\nThree weeks to go. Line-up is about 80% confirmed, tickets are moving, and the build weekend is getting close. Two things on my mind:\n\n- We are still short on volunteers, so if you can bring one person along, tell Nour.\n- The Sunday forecast for the field looks iffy, we will decide on wind cover at the go/no-go.\n\nEverything lives in our shared drive, have a poke around when you get a minute.\n\nProud of this crew. Let's make it a good one.\n\nAnouk",
                html: "<p>Hi everyone,</p><p>Three weeks to go. Line-up is about 80% confirmed, tickets are moving, and the build weekend is getting close. Two things on my mind:</p><ul><li>We are still short on volunteers, so if you can bring one person along, tell Nour.</li><li>The Sunday forecast for the field looks iffy, we will decide on wind cover at the go/no-go.</li></ul><p>Everything lives in our shared drive, have a poke around when you get a minute.</p><p>Proud of this crew. Let's make it a good one.</p><p>Anouk</p>",
            },
        ],
    },
    {
        kind: 'all-hands',
        subject: 'Volunteers needed for build weekend',
        messages: [
            {
                from: 'volunteers',
                daysAgo: 1,
                hour: 11,
                text: 'Hi all,\n\nWe still need about 10 hands for the build weekend, plus one for the Sunday morning first-aid slot. If you know someone reliable, send them my way. Meals and a weekend ticket included.\n\nThank you!\nNour',
            },
            {
                from: 'imke',
                daysAgo: 1,
                hour: 16,
                text: 'Hi Nour,\n\nWillem already said yes to the Sunday morning first-aid slot, so that one is covered. My neighbor Hanna is a certified first aider too, she did the harbor festival last year and she is happy to be the backup on Sunday.\n\nHer card is attached, you can call her.\n\nImke',
                attachments: [
                    {
                        filename: 'hanna groen.vcf',
                        vcard: {
                            firstName: 'Hanna',
                            lastName: 'Groen',
                            email: 'hanna.groen@example.com',
                            phone: '+31 6 3311 4477',
                            jobTitle: 'First aider',
                            notes: "Imke's neighbor. Did first aid at the harbor festival last year. Backup for Sunday morning.",
                            photo: 'hanna.jpg',
                        },
                    },
                ],
            },
        ],
    },
];

// --- Calendar: the team calendar's events, with crew attendees ---

// One line in a calendar, a team event's, a shift's or a personal one's. Its day counts from the festival Saturday
// (0 = festival day, negative = before it), resolved at seed time, so the festival always lands on a weekend.
export type SeededSlot = {
    title: string;
    daysFromFestival: number;
    startHour: number; // 9.5 is half past nine
    durationHours: number;
    allDay?: boolean;
    days?: number; // an all-day event's length, 1 when unset
    rrule?: string;
    location?: string;
    description?: string;
};

export type SeededEvent = SeededSlot & {
    organizer: LeadRole;
    attendees: (LeadRole | string)[]; // role or persona key
    replies?: Record<string, Exclude<Attendee['status'], 'accepted'>>; // by persona key; every other guest accepted
};

export const EVENTS: SeededEvent[] = [
    {
        title: 'Weekly production meeting',
        daysFromFestival: -33,
        startHour: 17,
        durationHours: 1,
        rrule: 'FREQ=WEEKLY;COUNT=5',
        location: 'Crew cabin',
        description: 'Standing check-in for all leads.',
        organizer: 'production',
        attendees: ['director', 'programming', 'production', 'comms', 'volunteers', 'finance', 'tech', 'liaison'],
    },
    {
        title: 'Site visit',
        daysFromFestival: -16,
        startHour: 10,
        durationHours: 3,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Walk the field, mark stages and camping.',
        organizer: 'production',
        attendees: ['production', 'tech', 'director'],
    },
    {
        title: 'Culture fund call',
        daysFromFestival: -15,
        startHour: 14,
        durationHours: 1,
        description: 'Grant check-in with the culture fund.',
        organizer: 'finance',
        attendees: ['finance', 'director'],
    },
    {
        title: 'Build day',
        daysFromFestival: -3,
        startHour: 8,
        durationHours: 10,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Fencing, stages, power.',
        organizer: 'production',
        attendees: ['production', 'tech', 'volunteers'],
    },
    {
        title: 'Tuimel Festival weekend',
        daysFromFestival: 0,
        startHour: 0,
        durationHours: 0,
        allDay: true,
        days: 2,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Doors Saturday and Sunday midday.',
        organizer: 'director',
        attendees: ['director', 'programming', 'production', 'comms', 'volunteers', 'finance', 'tech', 'liaison'],
    },
    {
        title: 'Go / no-go meeting',
        daysFromFestival: -1,
        startHour: 18,
        durationHours: 1,
        location: 'Crew cabin',
        description: 'Final call, including Sunday wind cover.',
        organizer: 'director',
        attendees: ['director', 'production', 'tech', 'programming', 'finance'],
        replies: { joris: 'tentative' },
    },
    {
        title: 'Load-in',
        daysFromFestival: -1,
        startHour: 12,
        durationHours: 2,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Backline, bar and catering in through the north track.',
        organizer: 'production',
        attendees: ['production', 'tech', 'liaison', 'sanne', 'tessa', 'ravi', 'fenna'],
    },
    {
        title: 'Soundchecks',
        daysFromFestival: -1,
        startHour: 14,
        durationHours: 3,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Main stage first, second stage from half past three.',
        organizer: 'tech',
        attendees: ['tech', 'programming', 'liaison', 'sanne', 'tessa'],
    },
    {
        title: 'Volunteer briefing',
        daysFromFestival: 0,
        startHour: 10,
        durationHours: 1,
        location: 'Crew cabin',
        description: 'Shifts, radios and who to call.',
        organizer: 'volunteers',
        attendees: ['volunteers', 'daan', 'fenna', 'imke', 'lars', 'yara', 'pieter', 'maud'],
    },
    {
        title: 'Strike',
        daysFromFestival: 2,
        startHour: 9,
        durationHours: 6,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Stages down, fencing stacked, field back to Griet.',
        organizer: 'production',
        attendees: ['production', 'tech', 'ravi', 'lars', 'sanne', 'liaison'],
        replies: { lieke: 'declined' },
    },
];

// --- Personal calendars: each persona's own calendar holds two SHIFTS of their own, such as a bar shift or an
// errand, and the whole PERSONAL_EVENTS pool. ---

export type SeededShift = SeededSlot & { persona: string }; // persona key

export const SHIFTS: SeededShift[] = [
    { persona: 'anouk', title: 'Walk the field before doors', daysFromFestival: 0, startHour: 10, durationHours: 1 },
    { persona: 'anouk', title: 'Dinner with the crew', daysFromFestival: -1, startHour: 19, durationHours: 2 },
    { persona: 'joris', title: 'Artist check-in desk', daysFromFestival: 0, startHour: 12, durationHours: 3 },
    { persona: 'joris', title: 'Pick up Wolf at the station', daysFromFestival: 0, startHour: 10, durationHours: 1 },
    { persona: 'saar', title: 'Site walk with Ravi', daysFromFestival: -1, startHour: 9, durationHours: 2 },
    { persona: 'saar', title: 'Meet Hein at the north track', daysFromFestival: -2, startHour: 8, durationHours: 1 },
    { persona: 'mees', title: 'Socials: doors and first act', daysFromFestival: 0, startHour: 12, durationHours: 2 },
    {
        persona: 'mees',
        title: 'Golden hour photos on the dune path',
        daysFromFestival: 0,
        startHour: 20,
        durationHours: 1,
    },
    { persona: 'nour', title: 'Volunteer check-in desk', daysFromFestival: 0, startHour: 11, durationHours: 3 },
    { persona: 'nour', title: 'Call Femke about gate duty', daysFromFestival: -2, startHour: 19, durationHours: 1 },
    { persona: 'bram', title: 'Box office cash-up', daysFromFestival: 0, startHour: 22, durationHours: 1 },
    { persona: 'bram', title: 'Collect the cash float', daysFromFestival: -1, startHour: 15, durationHours: 1 },
    { persona: 'timo', title: 'Generators in with Rob', daysFromFestival: -2, startHour: 9, durationHours: 2 },
    { persona: 'timo', title: 'Line check, barn stage', daysFromFestival: 0, startHour: 11, durationHours: 1 },
    { persona: 'lieke', title: 'Artist hospitality shift', daysFromFestival: 0, startHour: 14, durationHours: 4 },
    { persona: 'lieke', title: 'Quiet room ready for Wolf', daysFromFestival: 0, startHour: 12, durationHours: 1 },
    { persona: 'fenna', title: 'Bar shift', daysFromFestival: 0, startHour: 16, durationHours: 6 },
    { persona: 'fenna', title: 'Kegs in from Brouwerij Vlier', daysFromFestival: -1, startHour: 15, durationHours: 2 },
    { persona: 'daan', title: 'Gate shift', daysFromFestival: 0, startHour: 11, durationHours: 5 },
    { persona: 'daan', title: 'Count the wristbands with Bram', daysFromFestival: -1, startHour: 16, durationHours: 1 },
    { persona: 'sanne', title: 'Stage crew, second stage', daysFromFestival: 0, startHour: 13, durationHours: 6 },
    { persona: 'sanne', title: 'Changeover, barn stage', daysFromFestival: 1, startHour: 14, durationHours: 2 },
    { persona: 'ravi', title: 'Re-peg the second stage', daysFromFestival: 1, startHour: 8, durationHours: 2 },
    { persona: 'ravi', title: 'Stack the fencing for Hein', daysFromFestival: 2, startHour: 13, durationHours: 2 },
    { persona: 'joost', title: 'Workshop: screen printing', daysFromFestival: 1, startHour: 13, durationHours: 2 },
    { persona: 'joost', title: 'Set up the workshop tent', daysFromFestival: -1, startHour: 15, durationHours: 2 },
    { persona: 'imke', title: 'First aid post', daysFromFestival: 0, startHour: 12, durationHours: 6 },
    { persona: 'imke', title: 'Hand over to Willem', daysFromFestival: 1, startHour: 8, durationHours: 1 },
    { persona: 'lars', title: 'Waste round', daysFromFestival: 0, startHour: 18, durationHours: 3 },
    { persona: 'lars', title: 'Extra bins out', daysFromFestival: -2, startHour: 10, durationHours: 2 },
    { persona: 'yara', title: 'Camping host night shift', daysFromFestival: -1, startHour: 22, durationHours: 6 },
    { persona: 'yara', title: 'Toilets placed, camping field', daysFromFestival: -1, startHour: 9, durationHours: 1 },
    { persona: 'pieter', title: 'Box office', daysFromFestival: 0, startHour: 11, durationHours: 5 },
    { persona: 'pieter', title: 'Charge the scanners', daysFromFestival: -1, startHour: 20, durationHours: 1 },
    { persona: 'maud', title: 'Runner, Saturday peak', daysFromFestival: 0, startHour: 15, durationHours: 4 },
    {
        persona: 'maud',
        title: 'Train to Vlierzand with the two',
        daysFromFestival: -1,
        startHour: 10,
        durationHours: 1,
    },
    { persona: 'sem', title: 'Hang the art on the dune path', daysFromFestival: -1, startHour: 10, durationHours: 4 },
    { persona: 'sem', title: 'Find the angle with Iris', daysFromFestival: -1, startHour: 14, durationHours: 1 },
    { persona: 'tessa', title: 'Sound assistant, main stage', daysFromFestival: 0, startHour: 13, durationHours: 7 },
    { persona: 'tessa', title: 'Coil the cables, main stage', daysFromFestival: 1, startHour: 23, durationHours: 1 },
];

// Every persona gets the whole pool, so no line names one of them; friends, family and outsiders are fine. It is
// densest in the weeks a visitor lands on, about three and four weeks before the festival.
export const PERSONAL_EVENTS: SeededSlot[] = [
    {
        title: 'Morning run',
        daysFromFestival: -25,
        startHour: 7,
        durationHours: 0.5,
        rrule: 'FREQ=WEEKLY;COUNT=8;BYDAY=TU,TH',
        location: 'Park loop',
    },
    {
        title: 'Swimming',
        daysFromFestival: -28,
        startHour: 9,
        durationHours: 1,
        rrule: 'FREQ=WEEKLY;COUNT=4',
        location: 'Municipal pool',
    },
    {
        title: 'Sunday football',
        daysFromFestival: -27,
        startHour: 10,
        durationHours: 1.5,
        rrule: 'FREQ=WEEKLY;COUNT=3',
        location: 'Sports park, pitch 3',
    },
    {
        title: 'Green bin out',
        daysFromFestival: -26,
        startHour: 7.5,
        durationHours: 0.25,
        rrule: 'FREQ=WEEKLY;COUNT=3',
    },
    {
        title: 'Choir practice',
        daysFromFestival: -24,
        startHour: 20,
        durationHours: 1.5,
        rrule: 'FREQ=WEEKLY;COUNT=3',
        location: 'Community centre',
    },
    {
        title: 'Check the Vlierzand forecast',
        daysFromFestival: -7,
        startHour: 7.5,
        durationHours: 0.25,
        rrule: 'FREQ=DAILY;COUNT=10',
        description: 'Wind first, then rain. Sunday is the one to watch.',
    },
    { title: "Farmers' market", daysFromFestival: -28, startHour: 11, durationHours: 1, location: 'Market square' },
    {
        title: "Birthday dinner at Lotte's",
        daysFromFestival: -28,
        startHour: 19,
        durationHours: 3,
        description: 'Bring the chocolate cake.',
    },
    { title: 'Call Mum', daysFromFestival: -27, startHour: 16, durationHours: 0.5 },
    { title: 'Meal prep for the week', daysFromFestival: -27, startHour: 18, durationHours: 1 },
    { title: 'Dentist', daysFromFestival: -26, startHour: 8.5, durationHours: 0.5, location: 'Dentist, Molenweg' },
    {
        title: 'Lunch with Esther',
        daysFromFestival: -26,
        startHour: 12.5,
        durationHours: 1,
        location: 'Café De Wissel',
    },
    { title: 'Groceries', daysFromFestival: -26, startHour: 18.5, durationHours: 0.5 },
    {
        title: 'Order new wellies',
        daysFromFestival: -25,
        startHour: 12.75,
        durationHours: 0.25,
        description: 'The old pair split at the heel last year.',
    },
    { title: 'Pub quiz', daysFromFestival: -25, startHour: 20, durationHours: 2, location: 'De Gouden Karper' },
    { title: "Mum's birthday", daysFromFestival: -24, startHour: 0, durationHours: 0, allDay: true },
    {
        title: 'Bike in for a service',
        daysFromFestival: -24,
        startHour: 8.25,
        durationHours: 0.25,
        location: 'Fietsenmaker Van Dam',
    },
    { title: 'Lunch walk', daysFromFestival: -24, startHour: 12.5, durationHours: 0.5 },
    {
        title: 'Pick up the bike',
        daysFromFestival: -23,
        startHour: 17.5,
        durationHours: 0.5,
        location: 'Fietsenmaker Van Dam',
    },
    { title: 'Cinema with Bas', daysFromFestival: -23, startHour: 21, durationHours: 2.25, location: 'Filmhuis' },
    { title: 'Haircut', daysFromFestival: -22, startHour: 12.25, durationHours: 0.5 },
    { title: 'Friday drinks', daysFromFestival: -22, startHour: 17.5, durationHours: 2, location: "Café 't Hoekje" },
    {
        title: 'Hunt for a rain poncho',
        daysFromFestival: -21,
        startHour: 11,
        durationHours: 1.5,
        location: 'Flea market, Veemarkt',
    },
    { title: "Jesse's housewarming", daysFromFestival: -21, startHour: 20, durationHours: 3 },
    { title: "Lunch at my parents'", daysFromFestival: -20, startHour: 13, durationHours: 3 },
    { title: "Rewatch last year's aftermovie", daysFromFestival: -20, startHour: 21, durationHours: 0.5 },
    {
        title: 'GP appointment',
        daysFromFestival: -19,
        startHour: 8.75,
        durationHours: 0.25,
        location: 'Huisartsenpraktijk De Linde',
    },
    { title: 'Yoga', daysFromFestival: -19, startHour: 19.5, durationHours: 1, location: 'Studio Adem' },
    {
        title: 'Collect the wellies',
        daysFromFestival: -18,
        startHour: 12.5,
        durationHours: 0.5,
        location: 'Parcel point, Spar',
    },
    { title: 'Dinner with the neighbours', daysFromFestival: -18, startHour: 19, durationHours: 2 },
    {
        title: 'Car to the garage',
        daysFromFestival: -17,
        startHour: 8,
        durationHours: 0.25,
        location: 'Garage Hofstede',
        description: 'APK, and ask about the rattle.',
    },
    { title: 'Book a van for build week', daysFromFestival: -17, startHour: 12.5, durationHours: 0.25 },
    { title: 'Pick up the car', daysFromFestival: -16, startHour: 18, durationHours: 0.5, location: 'Garage Hofstede' },
    { title: 'Breakfast with Oma', daysFromFestival: -15, startHour: 8, durationHours: 1 },
    {
        title: 'Gig at Het Pakhuis',
        daysFromFestival: -15,
        startHour: 20.5,
        durationHours: 2.5,
        location: 'Het Pakhuis',
        description: 'Doors at 20:00. Earplugs.',
    },
    {
        title: 'Head torch and gas canister',
        daysFromFestival: -14,
        startHour: 11,
        durationHours: 1,
        location: 'Outdoor shop, city centre',
    },
    {
        title: "Ilse's birthday dinner",
        daysFromFestival: -14,
        startHour: 19,
        durationHours: 3,
        location: 'Restaurant De Vork',
    },
    { title: 'Brunch with Ilse and Bas', daysFromFestival: -13, startHour: 12, durationHours: 1.5 },
    {
        title: 'Wash the camping gear',
        daysFromFestival: -13,
        startHour: 16,
        durationHours: 1,
        description: 'Tent out on the balcony to dry.',
    },
    { title: 'Physio', daysFromFestival: -12, startHour: 8, durationHours: 0.75, location: 'Physio Oost' },
    { title: "Dinner at Bas's", daysFromFestival: -11, startHour: 19, durationHours: 2 },
    {
        title: 'Pick up radios from the hire shop',
        daysFromFestival: -10,
        startHour: 12.5,
        durationHours: 1,
        location: 'Radio hire, Industrieweg',
    },
    {
        title: 'Write the packing list',
        daysFromFestival: -9,
        startHour: 21,
        durationHours: 0.5,
        description: 'Wellies, poncho, head torch, earplugs, the good socks.',
    },
    { title: 'Day off', daysFromFestival: -8, startHour: 0, durationHours: 0, allDay: true },
    { title: 'Laundry, the warm and waterproof lot', daysFromFestival: -8, startHour: 10, durationHours: 1 },
    {
        title: 'Buy a cool box and ice packs',
        daysFromFestival: -7,
        startHour: 11,
        durationHours: 1,
        location: 'Hardware store',
    },
    { title: "Neighbours' barbecue", daysFromFestival: -7, startHour: 18, durationHours: 3 },
    {
        title: 'Pack the van',
        daysFromFestival: -6,
        startHour: 14,
        durationHours: 2,
        description: 'Tent, wellies, head torch, the good cool box.',
    },
    { title: 'Call Oma', daysFromFestival: -6, startHour: 19, durationHours: 0.5 },
    { title: 'Groceries for build week', daysFromFestival: -5, startHour: 18.5, durationHours: 0.75 },
    {
        title: 'Spare key to the neighbours',
        daysFromFestival: -5,
        startHour: 21,
        durationHours: 0.25,
        description: 'And ask them to water the tomatoes.',
    },
    { title: 'Pharmacy: plasters, sun cream, earplugs', daysFromFestival: -4, startHour: 12.5, durationHours: 0.5 },
    { title: 'Tent and sleeping bag in the car', daysFromFestival: -4, startHour: 21, durationHours: 0.5 },
    {
        title: 'Coffee on the way',
        daysFromFestival: -3,
        startHour: 7,
        durationHours: 0.5,
        location: 'Tankstation De Kruising',
    },
    {
        title: 'Chips in Vlierzand',
        daysFromFestival: -3,
        startHour: 19.5,
        durationHours: 1,
        location: 'Snackbar De Duin, Vlierzand',
    },
    {
        title: 'Breakfast at the bakery',
        daysFromFestival: -1,
        startHour: 8,
        durationHours: 0.75,
        location: 'Bakkerij Duinzicht, Vlierzand',
    },
    { title: 'Earplugs and a spare charger in the bag', daysFromFestival: 0, startHour: 8, durationHours: 0.25 },
    { title: 'Sunrise on the dune path', daysFromFestival: 1, startHour: 6, durationHours: 0.75 },
    { title: 'Train home', daysFromFestival: 2, startHour: 16.5, durationHours: 1.5, location: 'Vlierzand station' },
    { title: 'Sleep in after strike', daysFromFestival: 3, startHour: 8, durationHours: 3 },
    { title: 'Laundry, everything muddy', daysFromFestival: 3, startHour: 14, durationHours: 1 },
    { title: 'Recovery day', daysFromFestival: 4, startHour: 0, durationHours: 0, allDay: true },
    { title: 'Massage', daysFromFestival: 4, startHour: 11, durationHours: 1, location: 'Studio Adem' },
    { title: 'First run since the festival', daysFromFestival: 5, startHour: 7, durationHours: 0.75 },
    {
        title: 'Drinks with everyone who missed it',
        daysFromFestival: 6,
        startHour: 20,
        durationHours: 2,
        location: "Café 't Hoekje",
    },
    { title: "Nephew's birthday party", daysFromFestival: 7, startHour: 14, durationHours: 3 },
    {
        title: 'Dentist follow-up',
        daysFromFestival: 9,
        startHour: 8.5,
        durationHours: 0.5,
        location: 'Dentist, Molenweg',
    },
];

// --- Contacts (external ecosystem, added to a few leads' address books) ---

// `labels` are label names. The seeder adds one the owner's book does not hold yet.
export type SeededContact = VCardSpec & { owner: LeadRole; labels?: string[] };

export const CONTACTS: SeededContact[] = [
    {
        owner: 'programming',
        firstName: 'Wolf',
        lastName: 'Nachtlicht',
        email: 'wolf@nachtlicht-bookings.example',
        company: 'Nachtlicht Bookings',
        jobTitle: 'Booker',
        notes: 'Books the Saturday headliner.',
    },
    {
        owner: 'production',
        firstName: 'Griet',
        lastName: 'Tuimelaar',
        email: 'griet@hoeve-tuimelaar.example',
        phone: '+31 6 1234 5678',
        company: 'Hoeve Tuimelaar',
        jobTitle: 'Farmer',
        notes: 'Owns the field. Gate code by text.',
        labels: ['Important'],
    },
    {
        owner: 'production',
        firstName: 'Kees',
        lastName: 'Duin',
        email: 'kees@duinshuttle.example',
        company: 'Duin Shuttle',
        jobTitle: 'Operations',
        notes: 'Shuttle buses, 30-minute loop.',
        labels: ['Suppliers'],
    },
    {
        owner: 'production',
        firstName: 'Rob',
        lastName: 'Tempel',
        email: 'rob@vlierkracht-verhuur.example',
        phone: '+31 6 2010 4431',
        company: 'Vlierkracht Verhuur',
        jobTitle: 'Rentals',
        notes: 'Generators. Two 60 kVA plus a backup, in on Thursday.',
        labels: ['Suppliers'],
    },
    {
        owner: 'production',
        firstName: 'Hein',
        lastName: 'Klarenbeek',
        email: HEIN_KLARENBEEK.email,
        phone: '+31 6 2010 4432',
        company: 'Hekwerkverhuur Vlierzand',
        jobTitle: 'Deliveries',
        notes: 'Fencing, same as last year. Drops at the north track.',
        labels: ['Suppliers'],
    },
    { ...RUUD_DEKKER, owner: 'production', labels: ['Suppliers'] },
    {
        owner: 'finance',
        firstName: 'Marijke',
        lastName: 'Veen',
        email: 'marijke@cultuurfonds-kust.example',
        company: 'Cultuurfonds Kust',
        jobTitle: 'Grants contact',
        notes: 'Our culture-fund contact.',
    },
    {
        owner: 'comms',
        firstName: 'Bo',
        lastName: 'Reijn',
        email: 'bo@brouwerij-vlier.example',
        company: 'Brouwerij Vlier',
        jobTitle: 'Sales',
        notes: 'Regional brewery, bar supply.',
    },
    {
        owner: 'comms',
        firstName: 'Sanne',
        lastName: 'Post',
        email: 'sanne@kustkrant.example',
        company: 'Kustkrant',
        jobTitle: 'Culture desk',
        notes: 'Local press, wants the line-up reveal.',
    },
];

// --- Personal-drive files shared with a lead or a team (shared-with-me variety) ---

export type SeededShare = {
    owner: LeadRole;
    name: string; // lowercase filename
    body: string;
    shareWith: LeadRole | typeof TECH_TEAM_NAME; // a lead, or the tech team
};

export const PERSONAL_SHARES: SeededShare[] = [
    {
        owner: 'production',
        name: 'site access notes.txt',
        body: 'Gate code by text from Griet. Deliveries via the north track. Water point is behind the barn.',
        shareWith: TECH_TEAM_NAME,
    },
    {
        owner: 'liaison',
        name: 'artist riders.txt',
        body: 'Riders are modest this year. Two acts vegetarian catering, one needs a quiet room before the set.',
        shareWith: 'programming',
    },
];

// --- Personal notes doc, seeded into every persona's OWN drive (same cozy content for all —
// a private scratch pad, not shared). Role-agnostic on purpose so one document serves everyone. ---

export const NOTES: PersonalDoc = {
    name: 'my notes', // lowercase, no extension
    html: [
        '<h1>My notes</h1>',
        '<p>Just my own scratch pad for the festival. Nothing official, do not read too much into it.</p>',
        '<h2>Before the weekend</h2>',
        '<ul>',
        '<li>Pack rain gear, the field has no shelter if Sunday turns</li>',
        '<li>Charge the radio and grab a spare battery from the crew cabin</li>',
        '<li>Cash for the food trucks, the card reader crawls at peak</li>',
        '<li>Swap my Saturday lunch break so I can catch the barn stage set</li>',
        '<li>Say hi to the new volunteers, they will not know where anything is yet</li>',
        '</ul>',
        '<h2>My weekend, roughly</h2>',
        '<ul>',
        '<li>Friday: load-in from midday, dinner with the crew, early night (ha)</li>',
        '<li>Saturday: doors at midday, on shift most of the afternoon, off in the evening</li>',
        '<li>Sunday: go/no-go call first thing, then wind permitting, the good stuff</li>',
        '<li>Monday: strike, coffee, and a very long nap</li>',
        '</ul>',
        '<h2>Do not forget</h2>',
        '<ul>',
        '<li>The big thermos, last year the coffee ran out by ten</li>',
        '<li>That playlist for the drive back</li>',
        '<li>Sunset from the dune path on Saturday if there is a gap, it is worth it</li>',
        '</ul>',
        '<p>That is it. Back to work.</p>',
    ].join(''),
};

// Insert → Chart's chart as the docs editor stores one, in a paragraph, with the Artist sketch, cross-hatched bars and
// the hand-drawn font. The fixed seed draws the same wobble on every rebuild.
const sketchedChart = () => {
    const parts = newChartSpecParts(sampleChartSpec('column', 'Excalifont'));
    const look = { ...FLAT_CHART_LOOK, fill: solidFill('transparent', 'cross-hatch'), roughness: 1, seed: 7 };
    const { width, height } = CHART_DEFAULT_SIZE;
    return `<p><span class="chart" data-chart="${escapeHtml(JSON.stringify(parts))}" data-look="${escapeHtml(JSON.stringify(look))}" data-width="${width}" data-height="${height}"></span></p>`;
};

// --- A scratch doc in every persona's own drive, beside "my notes": someone made a file to see what the editor does.
// Not a tour. ---

export const TRYING_EIGEN: PersonalDoc = {
    name: 'trying eigen', // lowercase, no extension
    html: [
        '<h1>trying eigen|docs⟩</h1>',
        '<p>new doc, just poking around before the festival eats my week.</p>',
        '<p><strong>bold</strong> works. <em>italic</em> works. <s>so does this</s>.</p>',
        '<p><span class="figure"><img data-media-name="hands-up-at-camp.webp" alt="Arms up in front of the tents" width="420"></span></p>',
        '<p>trying out equations:</p>',
        displayedEquation('\\mathbf{eigen}\\,\\ket{\\text{docs}}'),
        '<p>click the equation and the LaTeX comes back. nice.</p>',
        '<p>we should insert a chart:</p>',
        sketchedChart(),
        '<ul><li><s>find the strikethrough button</s></li><li>look at the budget sheet</li><li>coffee</li></ul>',
    ].join(''),
    media: ['images/hands-up-at-camp.webp'],
};

export function personaByRole(role: LeadRole): Persona {
    const persona = PERSONAS.find((p) => p.role === role);
    if (!persona) throw new Error(`No persona for role ${role}`);
    return persona;
}

export function personaByKey(key: string): Persona {
    const persona = PERSONAS.find((p) => p.key === key);
    if (!persona) throw new Error(`No persona for key ${key}`);
    return persona;
}

// A seeded time on the demo's own clock: its day counts back on the Amsterdam calendar from `now`, so a clock change
// in between moves nothing to another day, and a UTC server dates it as a Dutch visitor reads it.
export function demoTime(now: Date, { daysAgo, hour, minute }: SeededTime): Date {
    const today = utcToLocal(now, DEMO_TIME_ZONE);
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day - daysAgo));
    return localToUtc(DEMO_TIME_ZONE, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, 0);
}

// The time of every message of a thread, the first at `start` and each later one by its `gap` or `at`.
export function threadTimes(now: Date, start: SeededTime | Date, later: readonly ChatLine[]): Date[] {
    const timeOf = (time: SeededTime) => demoTime(now, time);
    let previous = start instanceof Date ? start : timeOf(start);
    const times = [previous];
    for (const { text, gap = 2, at } of later) {
        const time = at ? timeOf(at) : new Date(previous.getTime() + gap * 60_000);
        if (time < previous) throw new Error(`The seeded message "${text}" is dated before the one it follows`);
        times.push(time);
        previous = time;
    }
    return times;
}

export function emailFor(localPart: string, mailDomain: string): string {
    return `${localPart}@${mailDomain}`;
}
