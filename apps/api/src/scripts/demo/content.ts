// Demo-world content for "Tuimel Festival" — a small, volunteer-run community arts & music
// festival, ~3 weeks out, line-up ~80% confirmed, short on volunteers, iffy Sunday forecast.
//
// This module is DATA ONLY: personas, folder names, document/mail/event/chat/contact text. The
// mechanics (seed-demo.ts) turn it into a live workspace through the real product surfaces. Keep
// it that way so a later content-deepening pass swaps data here without touching mechanics.
//
// Personas are keyed by a fixed local-part; the runtime email is `<key>@<MAIL_DOMAIN>`. Everything
// the data model keys on (ACLs, comments, calendar attendees, stickies creators) resolves by that
// email, so ids may be random per rebuild. All names, acts and vendors are fictional.

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
};

// 8 named leads do the visible authoring; 12 lighter crew fill the roster and @-mention lists.
export const PERSONAS: Persona[] = [
    { key: 'anouk', name: 'Anouk de Wit', title: 'Festival director', role: 'director' },
    { key: 'joris', name: 'Joris Bakker', title: 'Programming lead', role: 'programming' },
    { key: 'saar', name: 'Saar Vermeer', title: 'Production & logistics lead', role: 'production' },
    { key: 'mees', name: 'Mees de Groot', title: 'Comms & marketing', role: 'comms' },
    { key: 'nour', name: 'Nour El Amrani', title: 'Volunteer coordinator', role: 'volunteers' },
    { key: 'bram', name: 'Bram Visser', title: 'Finance & ticketing', role: 'finance' },
    { key: 'timo', name: 'Timo Jansen', title: 'Stage & tech lead', role: 'tech' },
    { key: 'lieke', name: 'Lieke Smits', title: 'Artist liaison & hospitality', role: 'liaison' },
    { key: 'fenna', name: 'Fenna Bos', title: 'Bar coordinator' },
    { key: 'daan', name: 'Daan Mulder', title: 'Gate & wristbands' },
    { key: 'sanne', name: 'Sanne Kok', title: 'Stage crew' },
    { key: 'ravi', name: 'Ravi Nair', title: 'Site crew' },
    { key: 'joost', name: 'Joost Peters', title: 'Workshops host' },
    { key: 'imke', name: 'Imke de Vries', title: 'First aid' },
    { key: 'lars', name: 'Lars Hendriks', title: 'Waste & recycling' },
    { key: 'yara', name: 'Yara Haddad', title: 'Camping host' },
    { key: 'pieter', name: 'Pieter van Dijk', title: 'Box office' },
    { key: 'maud', name: 'Maud Willems', title: 'Runner' },
    { key: 'sem', name: 'Sem Dekker', title: 'Décor & art' },
    { key: 'tessa', name: 'Tessa Meijer', title: 'Sound assistant' },
];

export const ADMIN_NAME = 'Tuimel Admin';
export const ADMIN_LOCALPART = 'admin';
export const ORG_NAME = 'Tuimel Festival';
export const TEAM_NAME = 'festival crew';
export const TEAM_MOUNT_NAME = 'festival';

// All seeded directory and file names are lowercase. Chat channels live under `chats/`.
export const TEAM_FOLDERS = ['production', 'programming', 'marketing', 'finance', 'volunteers', 'chats'] as const;
export type TeamFolder = (typeof TEAM_FOLDERS)[number];

// --- Documents (seeded via the shipped .docx -> eigendoc converter, dogfooding import) ---

export type DocComment = {
    // Slug used for the comment thread's chat name (lowercase, no extension).
    card: string;
    author: string; // persona key
    text: string;
    replies?: { author: string; text: string }[];
    assignTo?: LeadRole; // records an `assigned` activity + notification
};

export type SeededDoc = {
    folder: TeamFolder;
    name: string; // lowercase, no extension
    author: LeadRole;
    html: string; // rendered to .docx, then converted to an eigendoc
    comments: DocComment[];
};

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
            '<ul><li>Shuttle buses from the nearest station, every 30 minutes</li><li>Two generators plus a backup, quote pending</li><li>Camping field opens Friday midday</li></ul>',
            '<h2>Timeline</h2>',
            '<ul><li>Build weekend: fencing, stages, power</li><li>Load-in and soundchecks: Friday</li><li>Doors: Saturday and Sunday midday</li><li>Strike: Monday</li></ul>',
            '<h2>Responsibilities</h2>',
            '<p>Programming owns the line-up and stage times. Production owns the site and logistics. Volunteers owns the shift roster. Finance owns tickets and the budget. Comms owns the public info.</p>',
            '<h2>Open risks</h2>',
            '<p>The Sunday forecast for the exposed field looks rough. We decide on wind cover for the second stage at the go/no-go meeting.</p>',
        ].join(''),
        comments: [
            {
                card: 'volunteers-gap',
                author: 'saar',
                text: "We're still about 10 volunteers short for the build weekend. Can we push the call-out again?",
                replies: [{ author: 'nour', text: 'On it — sending a fresh call-out to the mailing list today.' }],
                assignTo: 'volunteers',
            },
            {
                card: 'sunday-weather',
                author: 'timo',
                text: 'The Sunday forecast for the field looks rough. Do we tent the second stage?',
                replies: [
                    { author: 'saar', text: "Let's decide at the go/no-go. Getting a quote for wind-rated cover." },
                ],
            },
            {
                card: 'shuttle-timing',
                author: 'joris',
                text: 'Last shuttle at 01:00 or 02:00? It affects the closing set.',
                replies: [{ author: 'mees', text: "02:00 — I'll put it on the info page." }],
            },
        ],
    },
    {
        folder: 'marketing',
        name: 'press release draft',
        author: 'comms',
        html: [
            '<h1>Press release — draft</h1>',
            '<p><em>For release once the line-up hits 100%.</em></p>',
            '<p>Tuimel Festival returns to the coastal fields near Vlierzand for a weekend of emerging music, spoken word, installations and workshops. Small on purpose: two stages, a food corner, and camping under big skies.</p>',
            '<p>Tickets are on sale now. The full line-up reveal follows in the coming days.</p>',
        ].join(''),
        comments: [
            {
                card: 'headline',
                author: 'anouk',
                text: 'Can we lead with the line-up reveal date instead of the theme?',
            },
        ],
    },
];

// --- Budget sheet (built as .xlsx, converted through the shipped xlsx -> eigensheets path) ---

export const BUDGET = {
    folder: 'finance' as TeamFolder,
    name: 'budget', // lowercase, no extension
    author: 'finance' as LeadRole,
    income: [
        ['Ticket sales', 42000],
        ['Bar', 9000],
        ['Culture fund grant', 15000],
        ['Local sponsors', 6000],
    ] as [string, number][],
    costs: [
        ['Artist fees', 28000],
        ['Stage & tech', 12000],
        ['Security', 6000],
        ['Sanitation', 4000],
        ['Shuttle buses', 3500],
        ['Marketing', 2500],
    ] as [string, number][],
};

// --- Slides deck fixture (authored once, byte-copied in; slides embed no identity) ---

export type SlideSpec = { heading: string; body: string };

export const SPONSOR_DECK = {
    folder: 'marketing' as TeamFolder,
    name: 'sponsor pitch', // lowercase, no extension
    author: 'comms' as LeadRole,
    slides: [
        { heading: 'Tuimel Festival', body: 'A small coastal festival for emerging music and art' },
        { heading: 'Who comes', body: 'A couple thousand curious people, two stages, camping under big skies' },
        {
            heading: 'Why partner with us',
            body: 'Warm, local, and independent — your name next to a much-loved weekend',
        },
        { heading: 'What you get', body: 'Stage credit, on-site presence, and a mention in every announcement' },
        { heading: "Let's talk", body: 'Reach out to the crew and join this edition' },
    ] as SlideSpec[],
};

// --- Stickies board fixture (authored once, byte-copied in; creator = persona email) ---

export type CardSpec = {
    title: string;
    description: string;
    column: string; // must be one of KANBAN.columns
    creator: string; // persona key; domainised into an email by the seeder
};

export const KANBAN = {
    folder: 'production' as TeamFolder,
    name: 'festival kanban', // lowercase, no extension
    columns: ['to do', 'doing', 'done'],
    cards: [
        {
            title: 'Confirm headliner contract',
            description: 'Signed and countersigned.',
            column: 'done',
            creator: 'joris',
        },
        { title: 'Order fencing', description: 'Build-weekend delivery.', column: 'doing', creator: 'saar' },
        {
            title: 'Publish full line-up',
            description: 'Once the last two acts confirm.',
            column: 'to do',
            creator: 'mees',
        },
        {
            title: 'Recruit 10 more volunteers',
            description: 'Blocked on the call-out going out.',
            column: 'to do',
            creator: 'nour',
        },
        {
            title: 'Fix generator quote',
            description: 'Two generators plus a backup.',
            column: 'doing',
            creator: 'saar',
        },
        { title: 'Print wristbands', description: 'Three tiers, camping included.', column: 'to do', creator: 'daan' },
        {
            title: 'Book shuttle buses',
            description: 'Every 30 minutes from the station.',
            column: 'done',
            creator: 'saar',
        },
        {
            title: 'Sunday wind cover',
            description: 'Decide at the go/no-go meeting.',
            column: 'to do',
            creator: 'timo',
        },
    ] as CardSpec[],
};

// --- Chat channels (real chat rooms in chats/, seeded via ChatRoom.postMessage as personas) ---

export type ChatLine = { author: string; text: string };
export type SeededChat = { name: string; messages: ChatLine[] };

export const CHATS: SeededChat[] = [
    {
        name: 'production',
        messages: [
            { author: 'saar', text: 'Build weekend plan is up in the drive. Shout if a slot clashes.' },
            { author: 'timo', text: 'Power run looks fine. One generator quote still open.' },
            { author: 'daan', text: 'Wristbands ordered — three tiers, camping included.' },
            { author: 'timo', text: 'Heads up: the Sunday forecast for the field is turning windy.' },
            { author: 'saar', text: 'How bad? The second stage is the exposed one.' },
            { author: 'timo', text: 'Gusts into the evening. No shelter out there right now.' },
            { author: 'sanne', text: 'We could move the quieter acts to the barn stage on Sunday.' },
            { author: 'anouk', text: "Let's keep the option open and decide at the go/no-go. Get a wind-cover quote." },
            { author: 'saar', text: 'On it. Will have numbers before the meeting.' },
            { author: 'ravi', text: 'Site crew can re-peg the second stage either way. Ready for both.' },
        ],
    },
    {
        name: 'volunteers',
        messages: [
            { author: 'nour', text: "We're about 10 short for the build weekend. Pushing the call-out today." },
            { author: 'maud', text: 'I can bring two friends for load-in Friday.' },
            { author: 'nour', text: 'Amazing — added you three to the roster.' },
            { author: 'yara', text: 'Camping host desk needs one more for the night shift.' },
            { author: 'imke', text: 'First aid is covered for both days, one gap Sunday morning.' },
            { author: 'nour', text: "I'll flag the Sunday morning gap in the call-out." },
            { author: 'lars', text: 'Waste team is set. Extra bins arrive with the fencing.' },
            { author: 'pieter', text: 'Box office wants two runners at peak. Any takers?' },
            { author: 'maud', text: 'Put me down as a runner for Saturday peak.' },
            { author: 'nour', text: 'Thanks all. Roster is looking a lot healthier.' },
        ],
    },
];

// --- Mail (raw RFC822 delivered into persona inboxes; dates spread over the past ~10 days) ---

export type SeededMail = {
    // 'inbox-thread' lands in one persona's inbox; 'all-hands' lands in every persona's inbox.
    kind: 'inbox-thread' | 'all-hands';
    to?: LeadRole; // required for inbox-thread
    from?: LeadRole; // sender lead for all-hands
    subject: string;
    messages: {
        fromExternal?: { name: string; email: string }; // else `from` is the persona key
        from?: string; // persona key
        daysAgo: number;
        hour: number;
        text: string;
    }[];
};

export const MAILS: SeededMail[] = [
    {
        kind: 'inbox-thread',
        to: 'programming',
        subject: 'Booking — Tuimel Festival',
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
                text: 'Hi Wolf,\n\nGreat news! Saturday it is. Fee as discussed, half on signing. Stage times land next week once the grid is locked. Sending the contract shortly.\n\nJoris',
            },
            {
                fromExternal: { name: 'Wolf Nachtlicht', email: 'wolf@nachtlicht-bookings.example' },
                daysAgo: 7,
                hour: 9,
                text: 'Perfect, thanks Joris. We will watch for the contract. One question: is there a backline on the second stage or do we bring our own?\n\nWolf',
            },
        ],
    },
    {
        kind: 'all-hands',
        from: 'director',
        subject: 'Three weeks out',
        messages: [
            {
                from: 'director',
                daysAgo: 2,
                hour: 8,
                text: 'Hi everyone,\n\nThree weeks to go. Line-up is about 80% confirmed, tickets are moving, and the build weekend is close. Two things I need from all of us:\n\n1. Volunteers — we are short. If you can bring one person, please tell Nour.\n2. The Sunday forecast for the field looks iffy. We decide on wind cover at the go/no-go.\n\nProud of this crew. Let us make it a good one.\n\nAnouk',
            },
        ],
    },
    {
        kind: 'all-hands',
        from: 'volunteers',
        subject: 'Volunteer call-out — build weekend',
        messages: [
            {
                from: 'volunteers',
                daysAgo: 1,
                hour: 11,
                text: 'Hi all,\n\nWe still need about 10 hands for the build weekend, plus one for the Sunday morning first-aid slot. If you know someone reliable, send them my way. Meals and a weekend ticket included.\n\nThank you!\nNour',
            },
        ],
    },
];

// --- Calendar (team calendar; future-dated relative to seed time; cross-persona attendees) ---

export type SeededEvent = {
    title: string;
    inDays: number;
    startHour: number;
    durationHours: number;
    allDay?: boolean;
    rrule?: string;
    location?: string;
    description?: string;
    organizer: LeadRole;
    attendees: (LeadRole | string)[]; // role or persona key
};

export const EVENTS: SeededEvent[] = [
    {
        title: 'Weekly production meeting',
        inDays: 2,
        startHour: 17,
        durationHours: 1,
        rrule: 'FREQ=WEEKLY;COUNT=4',
        location: 'Crew cabin',
        description: 'Standing check-in for all leads.',
        organizer: 'production',
        attendees: ['director', 'programming', 'production', 'comms', 'volunteers', 'finance', 'tech', 'liaison'],
    },
    {
        title: 'Site visit',
        inDays: 5,
        startHour: 10,
        durationHours: 3,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Walk the field, mark stages and camping.',
        organizer: 'production',
        attendees: ['production', 'tech', 'director'],
    },
    {
        title: 'Culture fund call',
        inDays: 6,
        startHour: 14,
        durationHours: 1,
        description: 'Grant check-in with the culture fund.',
        organizer: 'finance',
        attendees: ['finance', 'director'],
    },
    {
        title: 'Build day',
        inDays: 18,
        startHour: 8,
        durationHours: 10,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Fencing, stages, power.',
        organizer: 'production',
        attendees: ['production', 'tech', 'volunteers'],
    },
    {
        title: 'Tuimel Festival weekend',
        inDays: 21,
        startHour: 0,
        durationHours: 0,
        allDay: true,
        location: 'Hoeve Tuimelaar, Vlierzand',
        description: 'Doors Saturday and Sunday midday.',
        organizer: 'director',
        attendees: ['director', 'programming', 'production', 'comms', 'volunteers', 'finance', 'tech', 'liaison'],
    },
    {
        title: 'Go / no-go meeting',
        inDays: 20,
        startHour: 18,
        durationHours: 1,
        location: 'Crew cabin',
        description: 'Final call, including Sunday wind cover.',
        organizer: 'director',
        attendees: ['director', 'production', 'tech', 'programming', 'finance'],
    },
];

// --- Contacts (external ecosystem, added to a few leads' address books) ---

export type SeededContact = {
    owner: LeadRole;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    company?: string;
    jobTitle?: string;
    notes?: string;
};

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
    },
    {
        owner: 'production',
        firstName: 'Kees',
        lastName: 'Duin',
        email: 'kees@duinshuttle.example',
        company: 'Duin Shuttle',
        jobTitle: 'Operations',
        notes: 'Shuttle buses, 30-minute loop.',
    },
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

// --- Personal-drive files shared person-to-person (shared-with-me variety) ---

export type SeededShare = {
    owner: LeadRole;
    name: string; // lowercase filename
    body: string;
    shareWith: LeadRole;
};

export const PERSONAL_SHARES: SeededShare[] = [
    {
        owner: 'production',
        name: 'site access notes.txt',
        body: 'Gate code by text from Griet. Deliveries via the north track. Water point is behind the barn.',
        shareWith: 'tech',
    },
    {
        owner: 'liaison',
        name: 'artist riders.txt',
        body: 'Riders are modest this year. Two acts vegetarian catering, one needs a quiet room before the set.',
        shareWith: 'programming',
    },
];

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
