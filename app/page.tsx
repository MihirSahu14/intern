import Link from "next/link";
import LandingGraph from "@/components/LandingGraph";

/**
 * The public face. The cockpit lives behind sign-in at `/app`.
 *
 * Scrolling happens in this page's own container rather than on `body` —
 * the root layout pins `overflow-hidden` because the cockpit is a
 * fixed-viewport application, and that is not worth disturbing for a
 * marketing page.
 */

export const metadata = {
  title: "intern · a company brain you can see",
  description:
    "A company brain you can see, and interns that go find what it doesn't know yet. Nothing goes out without a person saying so.",
};

const TRACE = [
  { t: "$", text: "spawn map every mention of the ramp pilot across slack, drive and the wiki", tone: "fg" },
  { t: "·", text: "int-01kx  queued", tone: "faint" },
  { t: "·", text: "int-01kx  recalled 3 facts from the brain", tone: "dim" },
  { t: "·", text: "int-01kx  reading #ramp-pilot — 34 messages", tone: "dim" },
  { t: "+", text: "int-01kx  filed note-118 “the pilot is Slack-first”", tone: "ok" },
  { t: "!", text: "int-01kx  drafted act-01hw → outbox, waiting on you", tone: "warn" },
] as const;

const TONE: Record<string, string> = {
  fg: "text-fg",
  dim: "text-dim",
  faint: "text-faint",
  ok: "text-ok",
  warn: "text-warn",
};

export default function Landing() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col px-6 py-10 sm:px-10">
        <Nav />

        {/* ---- hero ---------------------------------------------------- */}
        <header className="enter mt-20 sm:mt-28">
          <p className="label">the company brain</p>
          <h1 className="mt-5 max-w-2xl text-2xl leading-[1.35] tracking-tight text-fg sm:text-[28px]">
            A company brain you can see, and interns that go find what it
            doesn&rsquo;t know yet.
          </h1>
          <p className="mt-5 max-w-xl leading-relaxed text-dim">
            Dispatch a long-running intern at a brief and leave it alone. It
            reads everything the company knows, does the work, and files what it
            learns back. Anything that would leave the building stops and waits
            for you.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/app"
              className="border border-accent/60 bg-accent/10 px-4 py-2 text-accent transition-colors hover:bg-accent/20"
            >
              open the cockpit →
            </Link>
            <span className="text-faint">no setup — it runs seeded until you connect anything</span>
          </div>
        </header>

        {/* ---- the brain ----------------------------------------------- */}
        <section className="enter mt-14 border border-line bg-panel" aria-label="Example company brain">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
            <span className="label">the brain · hover a node</span>
            <span className="text-faint">size = how much hangs off it</span>
          </div>
          <LandingGraph />
        </section>

        {/* ---- terminal ------------------------------------------------ */}
        <section className="enter mt-6 border border-line bg-panel" aria-label="Example intern run">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2">
            <span className="size-2 rounded-full bg-ok pulse-slow" />
            <span className="label">live · one intern</span>
          </div>
          <div className="overflow-x-auto p-4">
            <pre className="min-w-max leading-[1.9]">
              {TRACE.map((line) => (
                <div key={line.text}>
                  <span className="mr-3 select-none text-faint">{line.t}</span>
                  <span className={TONE[line.tone]}>{line.text}</span>
                </div>
              ))}
              <div>
                <span className="mr-3 select-none text-faint">$</span>
                <span className="caret text-fg">_</span>
              </div>
            </pre>
          </div>
        </section>

        {/* ---- the three mechanisms ------------------------------------ */}
        <section className="mt-24">
          <p className="label">why it isn&rsquo;t a chat window</p>
          <div className="mt-6 grid gap-px border border-line bg-line sm:grid-cols-3">
            <Panel
              title="It never sends"
              accent="text-warn"
              body="An intern that decides something should go out writes a draft and stops. Approval isn't a rubber stamp bolted on the end — it's the only way anything leaves."
            />
            <Panel
              title="Editing teaches it"
              accent="text-ok"
              body="The outbox keeps both halves: what the intern proposed and what you were actually willing to send. That difference becomes a fact the next intern reads first."
            />
            <Panel
              title="It asks"
              accent="text-k-question"
              body="When the brief leaves something out that the brain can't resolve, the intern parks and asks. There is no timeout that eventually guesses anyway."
            />
          </div>
        </section>

        {/* ---- how the brain fills --------------------------------------- */}
        <section className="mt-24">
          <p className="label">how the brain fills</p>
          <p className="mt-5 max-w-xl leading-relaxed text-dim">
            Everything the company observes lands once, immutably. Only what an
            intern could plausibly cite gets promoted to a fact — the rest stays
            in the log rather than bloating the graph.
          </p>
          <div className="mt-6 overflow-x-auto border border-line bg-panel p-5">
            <pre className="min-w-max leading-[1.9] text-dim">
              {`capture  →  observation      immutable, unique on (source, external_id)
              ↓ promote        only if an intern could cite it
            fact             provenance · confidence · validity window
              ↓
            graph node       wired back to whatever observed it`}
            </pre>
          </div>
          <p className="mt-5 max-w-xl leading-relaxed text-dim">
            Capturing the same thing twice is harmless. A second, independent
            observation of something already known doesn&rsquo;t duplicate it —
            it corroborates it, and confidence goes up. Facts are never deleted,
            only superseded.
          </p>
        </section>

        {/* ---- trust ---------------------------------------------------- */}
        <section className="mt-24">
          <p className="label">trust, and graduating</p>
          <p className="mt-5 max-w-xl leading-relaxed text-dim">
            Every surface carries its accepted-unedited rate — of the handovers
            you actually decided on, how often you took the work as written. Not
            &ldquo;did it succeed&rdquo;: editing a draft before sending it is
            the intern getting it wrong, even though the email went out.
          </p>
          <div className="mt-6 grid gap-px border border-line bg-line sm:grid-cols-3">
            <Stat value="8 / 9" label="slack · accepted unedited" tone="text-ok" />
            <Stat value="4 @ 80%" label="proposes graduation" tone="text-fg" />
            <Stat value="1" label="rejection revokes it" tone="text-warn" />
          </div>
          <p className="mt-5 max-w-xl leading-relaxed text-dim">
            A person confirms every graduation; nothing graduates on its own.
            Earning trust is slow and losing it is immediate, because the cost is
            asymmetric.
          </p>
        </section>

        {/* ---- close ---------------------------------------------------- */}
        <section className="mt-24 border border-line bg-panel p-8">
          <h2 className="text-fg">Point it at a brief and walk away.</h2>
          <p className="mt-3 max-w-lg leading-relaxed text-dim">
            It starts seeded, so there is nothing to configure before you can see
            it work. Connect Slack and mail when you want it acting for real.
          </p>
          <Link
            href="/app"
            className="mt-6 inline-block border border-accent/60 bg-accent/10 px-4 py-2 text-accent transition-colors hover:bg-accent/20"
          >
            open the cockpit →
          </Link>
        </section>

        <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-20 pb-6 text-faint">
          <span>intern · a terminal for the company brain</span>
          <a
            href="https://github.com/MihirSahu14/intern"
            className="transition-colors hover:text-dim"
          >
            source
          </a>
        </footer>
      </div>
    </div>
  );
}

function Nav() {
  return (
    <nav className="flex items-center justify-between">
      <span className="text-[30px] tracking-tight text-fg">
        intern<span className="text-accent">_</span>
      </span>
      <Link href="/app" className="text-dim transition-colors hover:text-fg">
        sign in →
      </Link>
    </nav>
  );
}

function Panel({ title, body, accent }: { title: string; body: string; accent: string }) {
  return (
    <div className="bg-panel p-5">
      <h3 className={accent}>{title}</h3>
      <p className="mt-3 leading-relaxed text-dim">{body}</p>
    </div>
  );
}

function Stat({ value, label, tone }: { value: string; label: string; tone: string }) {
  return (
    <div className="bg-panel p-5">
      <div className={`text-[19px] tabular-nums ${tone}`}>{value}</div>
      <div className="label mt-2">{label}</div>
    </div>
  );
}
