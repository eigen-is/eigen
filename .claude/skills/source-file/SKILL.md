---
name: source-file
description: Use when cleaning up, simplifying or reviewing one source file for readability, when writing or fixing the header comment at the top of a file, when a file has no header comment yet, or when creating a new source file in this repo. Also for a sweep that tidies the files of one folder one by one.
---

# Source file

A developer who has never seen the file reads it top to bottom and understands it. A short header says what the file is and where it sits. The code is the simplest code that works, and it needs few comments.

## The shape

1. A header comment of two to five `//` lines.
2. A blank line.
3. The imports, each on one line.
4. The code, members grouped: fields, constructor, getters, lifecycle, then the rest.

## The header

Write it last, once you understand the file. In plain words it says what the code does and why it exists, and where it sits: who calls it (routes, a background job, the SSE stream, a CLI), what it calls, when it runs.

It stays true whatever other files do. Facts another file owns, such as which kinds exist or who calls this file, appear only as examples ("such as"), never as a complete list. It names functions and concepts (`getHome`), never file paths, docs or line numbers. No history, no TODOs. Short sentences and common words, for a reader who may not be a native speaker.

Every `.ts`/`.tsx` source file gets one, `scripts/` and the `packages/sheet` fork included. Test files, generated files, config files and a barrel that only re-exports get none.

```ts
// A Home is everything one owner keeps on this server, such as a user's files, mail and calendar,
// or the smaller set a team has. Every request reaches that data through getHome(ownerId), which
// builds the Home on first use. It stays loaded while it is used and closes itself, databases
// included, after a few idle minutes. This base class owns that lifecycle; each kind of home
// decides which parts it has.

import * as path from 'node:path';
```

## Comments

The rules are in [CODE-STANDARDS.md § Code Style](../../../docs/CODE-STANDARDS.md#code-style). In short: a comment is rare, at most two lines, and says a why the code can't. Go through every comment in the file and ask in order:

1. **Does the code say it already?** A name, a type or the next line says what happens. Delete the comment.
2. **Is it a list or a tour?** Callers, flows, fields one by one, states, "see X". Delete it. The header gives the big picture with examples.
3. **Is it a design decision?** A reason that holds for the whole mechanism belongs once in the domain doc. Check the doc has it, add it there if not, and delete it here.
4. **Is it an edge case?** The test that pins it names it. If no test pins it, ask whether the case is worth code at all: a rare case that can't crash or block the server, lose data or leak access is accepted, and its code goes with the comment.
5. **Is it longer than the code it explains?** That is a patch smell. Report it as a finding (a special case to fix at the cause or drop), and don't polish the comment.
6. **What survives** is a why a careful reader would not guess, such as a unit, an ordering that matters, or a library quirk. Rewrite it in one or two plain sentences, the reason first.

A field or parameter gets a comment only for what its name and type can't say, such as a unit or who owns it. A class comment that repeats the file header goes.

## Cleaning up a file

1. Read the file and its siblings. Grep every exported or public member for its callers, tests included. What callers really use decides what can change.
2. Simplify without changing behaviour: drop dead members, inline a helper with one caller, merge copies, use `??`, `??=`, `Set` and `Map` instead of hand-written versions, replace index juggling with straight code. Drop every check on data our own typed code produced (a reply from our own child, a message between Homes, a row we wrote) and every option, export or reset only a test uses: the types are the contract, and validation lives only at a boundary ([CODE-STANDARDS.md § Code Philosophy](../../../docs/CODE-STANDARDS.md#code-philosophy)). A behaviour change is its own commit with its own test.
3. Rename what doesn't say what it is: shorthand names, or a concept spelled differently from the rest of the repo. A short name that reads as plain English where it is called, such as `atHome(ownerId)`, stays. A rename updates every caller in the same commit.
4. Order the file top-down: exports and the entry point first, then helpers in the order they are called. Code that belongs to another module moves there, and the same logic or fact in two files lives in one. Code that exists for another domain moves to that domain's folder; the host keeps at most the call. Keep it flat: no factory, registry or interface layer to make the move.
5. Split a long file when the split is clean. Past about 400 lines, look for one concern the rest only calls into, and split there if the result reads better. With no clean split, a long file stays whole.
6. Make types honest: a part that can be missing is optional. No new `as`.
7. Give every class member `public`, `private` or `protected`, the narrowest that compiles.
8. Split `import type { … }` from the value import of the same module, so each line fits.
9. Comments, as § Comments above.
10. Write the header.
11. Neighbouring files with the same smell: fix it when it is a few lines, otherwise list it in your report.

## Report

Every file you touch gets every step, a one-line edit or a follow-up fix to a file an earlier commit cleaned included: the bar is the whole file, not your diff. The report has one row per file, with a cell for each of steps 2 to 11: what changed, or "nothing" and why in a few words ("no shorthand names", "248 lines, one concern"). An empty cell says why it is empty. "It would bury the change in the diff" is not a reason: a rename, move or split goes in a commit of its own beside the change, and a comment pass goes in the same commit. Only a step that can't be done in this unit becomes a backlog row. List each patch smell from § Comments step 5 under the table.

| File | 2 simplify | 3 rename | 4 order, move | 5 split | 6 types | 7 visibility | 8 imports | 9 comments | 10 header | 11 neighbours |
|---|---|---|---|---|---|---|---|---|---|---|

## Verify

- `bunx biome check <files>`, then the workspace typecheck (`cd apps/api && bunx tsc --noEmit -p .`).
- The domain's tests: `cd apps/api && bun test --preload ./src/test/preload.ts ./src/test/<domain>/`.
- A cleanup that changes behaviour, or touches a lifecycle, a lock, a cache or a cross-home call, is not done until it has had the orchestrate skill's cold review and an adversarial hunt on that mechanism.
- Another agent working in the tree makes the machine slow, and a 5 s hook timeout then fails. Re-run the failing file alone or with `--timeout 60000` before you blame your change. Don't run `bun run check` while another agent works.
- The Write tool decodes `\u` escapes in the content it writes, so a file that needs such an escape gets the character from `String.fromCharCode`, or is edited another way.
