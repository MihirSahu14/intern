"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { AuthLoading, Authenticated, Unauthenticated, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import Cockpit, { stashSessionUri } from "./Cockpit";
import Consent, { JoinSlack } from "./Consent";
import SignIn from "./SignIn";

const Wait = ({ text }: { text: string }) => (
  <div className="flex h-full items-center justify-center bg-bg">
    <span className="text-faint">
      {text}
      <span className="caret">_</span>
    </span>
  </div>
);

export default function Gate() {
  // Back from Composio but not signed in yet: keep the one-time session_uri
  // through the GitHub round trip; the cockpit redeems it after.
  useEffect(stashSessionUri, []);
  return (
    <>
      <AuthLoading>
        <Wait text="checking session" />
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Member />
      </Authenticated>
    </>
  );
}

const JOIN_SEEN = "intern.slack_join_seen";

/** Blocked storage reads as seen: better never to show the step than to show it every load. */
const joinSeen = () => {
  try {
    return localStorage.getItem(JOIN_SEEN) === "1";
  } catch {
    return true;
  }
};

function Member() {
  const me = useQuery(api.users.viewer, {});
  // The invite is connections.mine's (https-only, env-driven); no second copy of that check.
  const slack = useQuery(api.connections.mine, {})?.find((c) => c.key === "slack");
  const [seen, setSeen] = useState(joinSeen);
  if (me === undefined) return <Wait text="loading" />;
  if (me === null) return <SignIn />;
  if (me.banned) return <Banned />;
  if (!me.accepted) return <Consent />;
  if (slack?.invite && !slack.connected && !seen) {
    const done = () => {
      try {
        localStorage.setItem(JOIN_SEEN, "1");
      } catch {
        // Storage blocked: the step shows again next time.
      }
      setSeen(true);
    };
    return <JoinSlack url={slack.invite} onDone={done} />;
  }
  return <Cockpit me={{ userId: me.userId, handle: me.handle, image: me.image }} />;
}

/** A dead end otherwise: no header, so no way to sign out and try another account. */
function Banned() {
  const { signOut } = useAuthActions();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg">
      <span className="text-faint">this account is blocked from the public brain</span>
      <button
        type="button"
        onClick={() => void signOut()}
        className="border border-line px-3 py-1 text-faint transition-colors hover:border-line-2 hover:text-fg"
      >
        sign out
      </button>
    </div>
  );
}
