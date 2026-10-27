---
name: source-file
description: Use when cleaning up, simplifying or reviewing one source file for readability, when writing or fixing the header comment at the top of a file, when a file has no header comment yet, or when creating a new source file in this repo. Also for a sweep that tidies the files of one folder one by one.
---

# Source file

A developer who has never seen the file reads it top to bottom and understands it. A short header says what the file is and where it sits. The code is the simplest code that works. The few comments are plain English.

## The shape

1. A header comment of two to five `//` lines.
2. A blank line.
3. The imports, each on one line.
4. The code, members grouped: fields, constructor, getters, lifecycle, then the rest.

## The header

Write it last, once you understand the file. It answers, in plain words:

- What does the code in this file do, and why does it exist?
- Where does it sit in the bigger picture? Who calls it (routes, a background job, the SSE stream, a CLI), what does it call, when does it run?

A header is self-contained: it states what this file owns and stays true whatever other files do. Facts another file owns, such as which kinds exist, which parts they have or who calls this file, appear only as examples ("such as", "for example"), never as a complete list. The test: after someone adds a caller, a subclass or a feature elsewhere, is the header still true?

It names functions and concepts (`getHome`), never file paths, docs or line numbers: those move, and the IDE finds callers anyway. No history, no TODOs, no "now uses X". The reader may not be a native English speaker: short sentences, common words, no chains of jargon. Every `.ts`/`.tsx` source file gets one, `scripts/` and the `packages/sheet` fork included. Test files, generated files and config files get none, and neither does a barrel file that only re-exports.

```ts
// A Home is everything one owner keeps on this server, such as a user's files, mail and calendar,
// or the smaller set a team has. Every request reaches that data through getHome(ownerId), which
// builds the Home on first use. It stays loaded while it is used and closes itself, databases
// included, after a few idle minutes. This base class owns that lifecycle; each kind of home
// decides which parts it has.

import * as path from 'node:path';
```

## Cleaning up a file

1. Read the file and its siblings. Grep every exported or public member for its callers, tests included. What callers really use decides what can change.
2. Simplify without changing behaviour: drop dead members, inline a helper with one caller, merge copies, use `??`, `??=`, `Set` and `Map` instead of hand-written versions, replace index juggling with straight code. A behaviour change is its own commit with its own test.
3. Rename what doesn't say what it is: a function, type, constant, parameter or file named in shorthand, or spelled differently from the same concept elsewhere in the repo. A rename updates every caller in the same commit.
4. Order the file so it reads top-down: the exports and the entry point first, then the helpers in the order they are called. Code that belongs to another file or module moves there; the same logic or fact in two files lives in one.
5. Split a long file when the split is clean. Past about 400 lines, look for a logical split, such as one concern the rest only calls into, and split there when the result is easier to understand. With no logical split, a long file stays whole. This is a recommendation, not a limit: the goal is the cleanest, easiest file to read.
6. Make types honest: a part that can be missing is optional. No new `as`.
7. Give every class member `public`, `private` or `protected`, the narrowest that compiles.
8. Split `import type { … }` from the value import of the same module, so each line fits.
9. Comments: keep only the WHY a maintainer can't see in the code, and only where it adds real value. Rewrite each as you would explain it to a colleague: whole sentences, one thought each, no comma-chained clauses or private shorthand. A comment that doesn't make the code clearer goes. Delete narration, history, review reasoning and audit tags.
10. Write the header.
11. Neighbouring files with the same smell: fix it when it is a few lines, otherwise list it in your report.

## Verify

- `bunx biome check <files>`, then the workspace typecheck (`cd apps/api && bunx tsc --noEmit -p .`).
- The domain's tests: `cd apps/api && bun test --preload ./src/test/preload.ts ./src/test/<domain>/`.
- A cleanup that changes behaviour, or touches a lifecycle, a lock, a cache or a cross-home call, is not done until it has had the orchestrate skill's cold review, and an adversarial hunt on that mechanism.
- Another agent working in the tree makes the machine slow, and a 5 s hook timeout then fails. Re-run the failing file alone or with `--timeout 60000` before you blame your change. Don't run `bun run check` while another agent works.
- The Write tool decodes `\u` escapes in the content it writes, so a file that needs such an escape gets the character from `String.fromCharCode`, or is edited another way.
