import Link from "next/link";
import LandingGraph from "@/components/LandingGraph";
import LandingStats from "@/components/LandingStats";
import Loop from "@/components/Loop";
import ThemeToggle from "@/components/ThemeToggle";

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
          <p className="label">the community brain</p>
          <h1 className="mt-5 max-w-2xl text-2xl leading-[1.35] tracking-tight text-fg sm:text-[28px]">
            A community brain you can see, and interns that go find what it
            doesn&rsquo;t know yet.
          </h1>
          <p className="mt-5 max-w-xl leading-relaxed text-dim">
            Dispatch a long-running intern at a brief and leave it alone. It
            reads everything the community knows, does the work, and files what it
            learns back. Drafts stop and wait for you. Nothing goes out until you
            approve it, and then it goes from your own Gmail or Slack.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/app"
              className="border border-accent/60 bg-accent/10 px-4 py-2 text-accent transition-colors hover:bg-accent/20"
            >
              Try it with GitHub →
            </Link>
            <span className="text-faint">a public test brain · everyone who signs in shares it</span>
          </div>
          <LandingStats />
        </header>

        {/* ---- the brain ----------------------------------------------- */}
        <section className="enter mt-14 border border-line bg-panel" aria-label="Example company brain">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
            <span className="label">example · one onboarding brief</span>
            <span className="text-faint">size = how much hangs off it</span>
          </div>
          <LandingGraph />
        </section>

        {/* ---- terminal ------------------------------------------------ */}
        <section className="enter mt-6 border border-line bg-panel" aria-label="Example intern run">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2">
            <span className="size-2 rounded-full bg-ok pulse-slow" />
            <span className="label">example · one intern</span>
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
              title="Nothing leaves without you"
              accent="text-warn"
              body="An intern that decides something should go out writes a draft and stops. You approve it, and it sends from your own connected account. Approval is the only way anything leaves."
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

        {/* ---- the loop -------------------------------------------------- */}
        <section className="mt-24">
          <p className="label">how it gets better</p>
          <p className="mt-5 max-w-xl leading-relaxed text-dim">
            Four steps, and the fourth feeds the second. That loop is the whole
            product: the brain learns this community by being corrected, not by
            being configured.
          </p>
          <Loop />
        </section>

        {/* ---- the community --------------------------------------------- */}
        <section className="mt-24">
          <p className="label">the community</p>
          <p className="mt-5 max-w-xl leading-relaxed text-dim">
            Everyone who signs in joins one public Slack workspace. Connect your
            own Gmail or Slack and an intern&rsquo;s approved draft goes out as
            you: an email from your address, a message under your name.
          </p>
        </section>

        {/* ---- close ---------------------------------------------------- */}
        <section className="mt-24 border border-line bg-panel p-8">
          <h2 className="text-fg">Point it at a brief and walk away.</h2>
          <p className="mt-3 max-w-lg leading-relaxed text-dim">
            It&rsquo;s a public test brain — sign in with GitHub and everything
            you do joins what everyone else has taught it. Drafts stop and wait
            for you; nothing goes out until you approve it.
          </p>
          <Link
            href="/app"
            className="mt-6 inline-block border border-accent/60 bg-accent/10 px-4 py-2 text-accent transition-colors hover:bg-accent/20"
          >
            Try it with GitHub →
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
      <div className="flex items-center gap-3">
        <ThemeToggle />
        <Link href="/app" className="text-dim transition-colors hover:text-fg">
          sign in →
        </Link>
      </div>
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
