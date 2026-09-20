/**
 * How a brief becomes work, and how the work teaches the brain.
 *
 * This replaced an ASCII pipeline that described the previous architecture —
 * observations promoted into facts, confidence scores, validity windows — none
 * of which survived the move into Convex. The loop below is what the code
 * actually does, which is also the only interesting claim the product makes:
 * step four feeds step one.
 */

const STEPS = [
  {
    n: "1",
    title: "you brief",
    body: "One sentence, no workflow to configure. “Draft a Slack post introducing Intern.”",
  },
  {
    n: "2",
    title: "it reads the brain",
    body: "Before thinking, the intern pulls the facts that bear on the task — including what people corrected last time.",
    tie: "reads",
  },
  {
    n: "3",
    title: "it works, then stops",
    body: "It files what it learned as facts, and anything outbound becomes a draft. An intern has no send tool.",
    tie: "writes",
  },
  {
    n: "4",
    title: "you approve or edit",
    body: "Editing before approving is the training signal: the change is filed as a fact, so the next intern starts with it.",
    tie: "teaches",
  },
];

export default function Loop() {
  return (
    <figure className="mt-6">
      <ol className="grid gap-px border border-line bg-line sm:grid-cols-4">
        {STEPS.map((s) => (
          <li key={s.n} className="flex flex-col gap-2 bg-panel p-4">
            <div className="flex items-baseline gap-2">
              <span className="text-accent tabular-nums">{s.n}</span>
              <span className="text-fg">{s.title}</span>
            </div>
            <p className="leading-relaxed text-dim">{s.body}</p>
            {s.tie ? (
              <span className="mt-auto pt-2 text-faint">
                <span aria-hidden="true">↓ </span>
                {s.tie} the brain
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {/* The shared surface every step above is really talking to. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border border-line border-t-0 bg-raised px-4 py-3">
        <span className="text-fg">the brain</span>
        <span className="text-dim">
          one set of facts, shared by everyone who signs in
        </span>
        <span className="ml-auto text-faint">
          step 4 writes what step 2 will read
        </span>
      </div>

      <figcaption className="mt-5 max-w-xl leading-relaxed text-dim">
        Nobody writes a rule. A person rewrites a line before approving it, that
        rewrite becomes a fact, and the next brief retrieves it — so the brain
        gets more specific about this company every time somebody corrects it.
      </figcaption>
    </figure>
  );
}
