---
name: source-file
description: Use when cleaning up, simplifying or reviewing one source file for readability, when writing or fixing the header comment at the top of a file, when a file has no header comment yet, or when creating a new source file in this repo. Also for a sweep that tidies the files of one folder one by one.
---

# Source file

A developer who has never seen the file reads it top to bottom and understands it: a short header says what it is and where it sits, and the code is the simplest that works, with few comments. The rules are [CODE-STANDARDS.md § Code Style](../../../docs/CODE-STANDARDS.md#code-style); this is how to apply them.

The shape: a header comment of two to five `//` lines, a blank line, the imports (each on one line), then the code, members grouped as fields, constructor, getters, lifecycle, the rest.

## The header

Write it last, once you understand the file. In short plain sentences: what the code does, why it exists, and where it sits: who calls it (routes, a background job, the SSE stream, a CLI), what it calls, when it runs. Facts another file owns, such as which kinds exist or who calls this file, appear only as examples ("such as"), never as a complete list. It names functions and concepts (`getHome`), never file paths, docs or line numbers. No history, no TODOs.

```ts
// A Home is everything one owner keeps on this server, such as a user's files, mail and calendar,
// or the smaller set a team has. Every request reaches that data through getHome(ownerId), which
// builds the Home on first use. It stays loaded while it is used and closes itself, databases
// included, after a few idle minutes. This base class owns that lifecycle; each kind of home
// decides which parts it has.

import * as path from 'node:path';
```

## Comments

Ask of every comment in the file, in order:

1. **Does the code say it already?** A name, a type or the next line. Delete it.
2. **Is it a list or a tour?** Callers, flows, fields one by one, states, "see X". Delete it; the header gives the big picture by example.
3. **Is it a design decision?** A reason for the whole mechanism belongs once in the domain doc: add it there if missing, delete it here.
4. **Is it an edge case?** The test that pins it names it. With no test, ask whether the case is worth code at all: a rare case that can't crash or block the server, lose data or leak access is accepted, and its code goes with the comment.
5. **Is it longer than the code it explains?** A patch smell: report it as a finding (a special case to fix at the cause or drop); don't polish the comment.
6. **What survives** is a why a careful reader would not guess (a unit, an ordering that matters, a library quirk), rewritten in one or two plain sentences, reason first.

A field or parameter gets a comment only for what its name and type can't say, such as a unit or an owner. A class comment that repeats the header goes.

## Cleaning up a file

1. Read the file and its siblings. Grep every exported or public member for its callers, tests included: what callers use decides what can change.
2. Simplify without changing behaviour: drop dead members, inline a one-caller helper, merge copies, use `??`, `??=`, `Set` and `Map` over hand-written versions, straighten index juggling. Drop every check on data our own typed code produced (a reply from our own child, a message between Homes, a row we wrote) and every option, export or reset only a test uses ([CODE-STANDARDS.md § Code Philosophy](../../../docs/CODE-STANDARDS.md#code-philosophy)). A behaviour change is its own commit with its own test.
3. Rename what doesn't say what it is: shorthand, or a concept spelled differently from the rest of the repo. A short name that reads as plain English at the call, such as `atHome(ownerId)`, stays. A rename updates every caller in the same commit.
4. Order top-down: exports and the entry point first, then helpers in call order. Code that belongs to another module moves there, the same logic or fact in two files ends up in one, and code that exists for another domain moves to that domain's folder, the host keeping at most the call. Stay flat: no factory, registry or interface layer to make the move.
5. Split a long file only when the split is clean: past about 400 lines, look for one concern the rest only calls into. With no clean split it stays whole.
6. Make types honest: a part that can be missing is optional. No new `as`.
7. Give every class member `public`, `private` or `protected`, the narrowest that compiles.
8. Split `import type { … }` from the value import of the same module.
9. Comments, as § Comments.
10. Write the header.
11. Neighbouring files with the same smell: fix it when it is a few lines, otherwise list it in your report.

## Report

Every file you touch gets every step, a one-line edit or a follow-up to a file an earlier commit cleaned included: the bar is the whole file, not your diff. One row per file, a cell per step 2 to 11 saying what changed, or "nothing" and why ("no shorthand names", "248 lines, one concern"); no empty cell. "It would bury the change in the diff" is no reason: a rename, move or split gets its own commit beside the change, and a comment pass goes in the same commit. Only a step that can't be done in this unit becomes a backlog row. List each patch smell (§ Comments step 5) under the table.

| File | 2 simplify | 3 rename | 4 order, move | 5 split | 6 types | 7 visibility | 8 imports | 9 comments | 10 header | 11 neighbours |
|---|---|---|---|---|---|---|---|---|---|---|

## Verify

- `bunx biome check <files>`, then the workspace typecheck (`cd apps/api && bunx tsc --noEmit -p .`), then the domain's tests (`cd apps/api && bun test --preload ./src/test/preload.ts ./src/test/<domain>/`).
- A cleanup that changes behaviour, or touches a lifecycle, a lock, a cache or a cross-home call, is done only after the orchestrate skill's cold review and an adversarial hunt on that mechanism.
- Another agent in the tree slows the machine and a 5 s hook timeout fails: re-run the failing file alone or with `--timeout 60000` before you blame your change, and don't run `bun run check` while another agent works.
- The Write tool decodes `\u` escapes, so a file that needs one gets the character from `String.fromCharCode`, or is edited another way.
