# About pages

A proposal for step 2 of the public site: one About overview and one short page per app. Step 1, the landing page, top bar, footer, Support, changelog and blog, ships first because all its content exists. Nothing here is built yet. The owner approved the look in a mock, and the text below is a first draft.

## Why

The help center answers "how do I do this?". Nothing answers "what does this app do?" before someone installs Eigen, and the landing page no longer shows screenshots. These pages carry that: what each app is, how it looks, and where to read more.

## What it is

Two kinds of page in `apps/index`, both static and prerendered like the blog.

- `/about`: a short introduction, then a list of the apps. The introduction says what Eigen is, what the name means, that it is open source under the MIT license, and that it is pre-1.0. Each row has a small screenshot, the wordmark such as `eigen|mail⟩`, and one line, and links to that app's page. It sits in the one reading column the blog uses, not in a grid: the owner found a grid of ten screenshots too busy.
- `/about/<app>`: one page per app, written and laid out like a blog post. The headline is `your own|sheets⟩`, followed by an intro, a screenshot or a video, and three or four short sections with a heading, a few sentences and sometimes another image. The sections are linked from the table of contents in the gutter, and each claim links to its help article. Older and newer become Previous and Next. No general fluff, no feature tiles.

The apps are the ten the landing page names: mail, drive, docs, sheets, slides, vector, calendar, contacts, chat and stickies.

## How it fits what step 1 built

- The top bar shows `eigen|about⟩`. The pages use `SitePage`, `ReadingLayout`, `ArticleToc`, the breadcrumb and the blog's pager as they are.
- The rows use `.eigen-list-item`, each washed in its own app's color.
- When these pages ship, the app words on the landing page point at `/about/<app>` instead of the Support sections, and the footer gains an About link. A Support section page for an app gains a small "What is Sheets?" link.
- Content is Markdown with frontmatter under `apps/index/src/data/about/`, through the same build steps as the blog, so media grids and heading anchors work unchanged. It needs no API route, migration or package.

## Rules for the text

- Every claim comes from a help article or the code, and links to the article. Nothing is promised that a server can turn off: the demo is a link an admin adds, so these pages do not mention or link it.
- The first draft of each app's one line:

| App | Line |
|---|---|
| Mail | Read, write and organize your email. |
| Drive | Your files, in folders, shared when you want. |
| Docs | Write and edit documents, saved as you type. |
| Sheets | Spreadsheets and formulas. |
| Slides | Build and present decks. |
| Vector | Drawings and diagrams on an infinite canvas. |
| Calendar | Events, invitations and shared calendars. |
| Contacts | The people you know, in one address book. |
| Chat | Messages and files, in real time. |
| Stickies | Boards for your tasks and ideas. |

- The Mail page says that a message is a plain `.eml` file and that a whole mailbox comes out over IMAP. The web app exports one message at a time, so the page does not promise more. Contacts and Calendar name `.vcf` and `.ics`.
- Vector's page can reuse the text of the blog post "Eigen: Vector".

## What has to be made first

New screenshots and videos, and this is the real work. The media under `public/data/blog/media/` are stand-ins:

| Source | Used for | Problem |
|---|---|---|
| `2026-04-11-eigen-six-months-later` | Mail, Drive, Docs, Sheets, Calendar, Contacts | Old design, with a colored top bar |
| `2026-08-14-eigen-demo` | Slides, Vector, Chat, Stickies, the Sheets video | Current, but with the demo banner, which has to be cropped. Stickies has a dialog open |
| `2025-10-03-eigen-proof-of-concept` | The Drive, Docs and Stickies videos | The first proof of concept, far out of date |

Retake them from the Tuimel demo workspace in the current design, with nothing open and no banner, one or two per app, and keep the videos short.

## Open

- The wording of every page, in the owner's voice.
- Whether the Support section pages should link here, or only the landing page and footer.
