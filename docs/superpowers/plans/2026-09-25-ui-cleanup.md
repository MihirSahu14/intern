# UI cleanup: make the cockpit obvious

**Goal:** a first-time visitor sees one clear thing to do (brief an intern), sees
what's waiting for them (the outbox), and can look at the brain, without raw JSON,
ID fragments, duplicate lists or stale copy.

**Source:** Mihir's UI audit of prod, 2026-09-25. Branch `ui-cleanup`, cut from `main`.

## Global Constraints

- **Read before writing:** read `AGENTS.md`/`CLAUDE.md`. Before touching `convex/`, read
  `convex/_generated/ai/guidelines.md`. This is Next.js 16: check
  `node_modules/next/dist/docs/` before using any Next API you haven't seen in this repo.
- **Styling and deps:**
  - Style with the existing Tailwind tokens (`fg`, `dim`, `faint`, `line`, `line-2`,
    `panel`, `accent`, `ok`, `warn`, `err`, `term-*`).
  - Both themes (dark default, light "ink on paper") must stay readable.
  - Add no new dependencies.
- **Privacy rules stay exactly as they are:**
  - `visibleTo`;
  - `redactEmails` for non-owners;
  - `displayTask` for non-owners;
  - owner-only drafts, questions and logs.
  - No change may show a non-owner anything they can't see today.
- **Copy voice:** lower-case UI labels, short plain sentences, no marketing words.
  Match the surrounding comment density and idiom.
- **No live calls:** never run `npx convex dev`, `npx convex deploy`, `npx convex run` or
  `npx convex env`, and make no real network or model calls.
- **Commits:** every commit ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Green gate:** `npm test`, `npx vitest run`, `npx tsc --noEmit -p convex`,
  `npx tsc --noEmit`, `npm run build`, and `npm run lint` with 0 errors.
- **If a permission classifier denies anything, stop and report it.** Never work
  around a denial.

## Task 1: Copy that matches what the product does now

Real sends work now (Gmail and Slack through Composio, after approval), and the
community lives in a public Slack workspace. Several strings still say otherwise.

**Landing page (`app/page.tsx`, `components/Loop.tsx`, `components/LandingStats.tsx`):**
- **Lead paragraph ending:** replace "Drafts stop and wait for you; in this public sandbox
  nothing is ever sent." with "Drafts stop and wait for you. Nothing goes out until you
  approve it, and then it goes from your own Gmail or Slack."
- **"It never sends" card:**
  - retitle it "Nothing leaves without you";
  - body: "An intern that decides something should go out writes a draft and stops.
    You approve it, and it sends from your own connected account. Approval is the only
    way anything leaves."
- **Closing section:** replace "Drafts stop and wait for you; nothing is ever sent." with
  "Drafts stop and wait for you; nothing goes out until you approve it."
- **Loop step 3:** "An intern has no send tool." becomes "An intern can't send on its own."
- **Stats line:** pluralize correctly: "1 person has tried it", "N people have tried it".
  Same for facts ("1 fact") and drafts ("1 draft approved").
- **New section before the closing CTA:** heading "THE COMMUNITY", body:
  "Everyone who signs in joins one public Slack workspace. Connect your own Gmail or
  Slack and an intern's approved draft goes out as you: an email from your address, a
  message under your name." Match the existing section styling on the page.

**Cockpit:**
- **Banner** (`NOTICE` in `components/Cockpit.tsx`) becomes: "Public test brain: briefs
  and facts are visible to everyone. Your drafts, questions and sends are private to
  you. Don't put anything private in a brief."
- **Header:** "community brain" stays, and the landing says "company brain", so make
  the landing's hero eyebrow "THE COMMUNITY BRAIN".
- **Theme toggle** (`components/ThemeToggle.tsx`): give it a visible text label "theme"
  next to the dot, plus `title`/`aria-label` "switch light/dark".
- **`components/Teach.tsx` heading:** "TELL IT SOMETHING / no intern needed" becomes
  "ADD A FACT" with subline "goes straight into the brain".
- **`components/Outbox.tsx`:** the bare "live" badge becomes "sends for real", with a
  `title` "Approving sends from your connected account."
- **`components/InternRail.tsx`:**
  - Remove the "live/sim · N calls" line, which carries no user meaning.
  - Replace the "0/17"-style count in the heading with "N running" (running or queued),
    and hide it when N is 0.

**Tests:** a node test for the pluralize helper (put it in `lib/`, e.g.
`lib/plural.ts`: `plural(1,"person","people")` → "1 person", `plural(0,...)` → "0 people",
`plural(2,"fact")` → "2 facts").

## Task 2: Show the member's own words, not the assembled resume text

A resumed intern's `task` holds the original ask plus the answers. Owners currently
see that whole text on intern cards and terminal tabs. Before the fix to PR #17, it
was a 9-deep "You asked … Original task: You asked …" chain.

- **Everywhere a task is shown as a label** (intern cards in `InternRail`, terminal
  filter tabs, the community feed, the member page): show `displayTask ?? task`,
  for owners too.
- **The full `task` stays available to the owner** behind a small "details" disclosure
  on their own card.
- **Terminal filter tabs** (`components/Terminal.tsx`): label each tab with the first ~24
  characters of that intern's `displayTask ?? task`, ellipsized, instead of the ID
  fragment (`352m`, `34vg`). Keep the ID only in the tab's `title`.
- **Data:** if `interns.list` doesn't already return `displayTask` to the owner, return
  it. The non-owner shape must not change.
- **Tests:** convex-test that the owner receives `displayTask` for a resumed intern.

## Task 3: The terminal speaks human; send errors say why

**Fenced blocks:**
- The log stream prints the model's raw output, including multi-line fenced blocks
  (```` ```action ````, ```` ```fact ````, ```` ```question ````) with JSON and fact IDs.
- Collapse each fenced block in the rendered log into one line: `drafted <kind> → <to>`
  for action, `noted: <title>` for fact, `asked: <question>` for question. Fall back to
  `(structured output)` when the JSON doesn't parse.
- Put the collapsing in a pure function in `lib/` (for example
  `lib/log-view.ts: collapseBlocks(lines) → lines`) with node tests:
  - an action block;
  - a fact block;
  - a question block;
  - a block split across several log lines;
  - an unterminated block, where the rest stays hidden and there is no crash;
  - plain lines untouched.
- Add a small "raw" toggle in the terminal header that shows the uncollapsed stream.

**Send errors:**
- In `convex/send.ts`, a failed send stores a generic `sendError` ("The send didn't go
  through. Retry, or reconnect if it keeps failing."). Keep that sentence, and append
  the provider's reason when there is one: ` (Slack said: <reason>)` or
  ` (Gmail said: <reason>)`.
- `<reason>` is the first line of the provider/Composio error message, with Composio
  log IDs (`(log_…)`) stripped, emails passed through `redactEmails`, and a
  120-character cap.
- `sendError` is already owner-only. Keep it that way.
- Node or convex tests cover: a reason appended; a log ID stripped; the cap applied;
  no reason means the sentence alone.

## Task 4: A graph that reads as a map

In `convex/facts.ts` `graph` (server) and `components/BrainGraph.tsx` (client):
- **Labels:**
  - Pass every node label through `redactEmails`, for owners too.
  - Intern labels use `displayTask ?? task`.
  - The graph is a public map; addresses belong in the outbox.
- **Leave out cancelled interns.** Their facts and drafts, if any, attach to nothing
  and are shown unlinked, which is the existing behaviour for missing parents.
- **The `src:seed` node** is labelled "starter facts".
- **Stop drifting:** after the initial layout settles, the simulation stops. A node
  dragged by the user may re-heat it briefly, then it stops again. Find the existing
  force-simulation settings in `BrainGraph.tsx` and make it settle (for example,
  raise alpha decay or stop at a cooldown). Don't rewrite the renderer.
- **Tests:** extend the existing graph convex-tests:
  - an owner's intern label with an email is redacted;
  - a cancelled intern is absent;
  - the seed source label is "starter facts".

## Task 5: One obvious place to start

Restructure `components/Cockpit.tsx`'s layout. Keep every existing capability; move
and merge, don't delete.

1. **The brief input moves to the top of the center column**, directly under the
   banner.
   - Reuse `CommandBar`, styled as the primary control: taller (py-2), text-fg, an
     accent-colored run button, and the placeholder "brief an intern, e.g. Post in
     #all-intern-community: hi from Intern".
   - The `try:` example chips sit directly under it (still only when the member has no
     interns).
   - Keep `/` to focus.
2. **The center column gets two tabs under the input: `brain` and `log`.**
   - `brain` shows the graph, with its filter box and the node/edge count overlay.
   - `log` shows the terminal at full height; the drag-resize handle goes, since
     there's no split any more.
   - The default is `brain`.
   - Submitting a brief switches to `log` and filters to the new intern if that's
     easy. Otherwise switching is enough.
   - Clicking an intern in the activity list switches to `log` and sets the filter.
3. **Right rail order:** Questions (only when there are any), Outbox, then one
   **Activity** section.
   - Activity has two tabs, `mine` (the `InternRail` list with retry/kill) and
     `everyone` (the `Feed`). It replaces the separate Community and Interns sections.
   - Default: `mine` if the member has interns, else `everyone`.
   - `Teach` ("ADD A FACT") moves to the bottom of the right rail as a collapsed
     disclosure.
4. **Left rail** (`BrainRail`): drop the BRAIN nodes/edges counts, which the graph
   overlay already shows. Keep Accounts, Layers and Node.
5. **Header:** unchanged apart from Task 1's theme label.

**Checks:**
- The layout must fit a 1280×720 viewport with no page scroll. Rails scroll
  internally.
- There's no test harness for React components. Types and the build cover
  compilation; the controller checks the result in a browser afterwards.

## Task 6: Accounts that don't need a paragraph

In `components/BrainRail.tsx`, the accounts section:
- **Each connector is one row:** name, status ("connected as @x in Y" or "not
  connected"), and a bordered button: `connect` or `disconnect` (a real `<button>` with
  the existing bordered style, not a text link).
- **The Composio disclosure goes into a small `ⓘ` toggle per row**, collapsed by
  default. Keep the exact disclosure text from `lib/connectors.ts`.
- **One muted line under a not-yet-connected row**, saying what connecting enables:
  - Gmail: "send approved emails from your address";
  - Slack: "post approved messages under your name".
- **Keep:** the "Join the community Slack first" invite link (shown when set and Slack
  isn't connected) and the Gmail capture toggle, if present, each on one line.
