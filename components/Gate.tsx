"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { AuthLoading, Authenticated, Unauthenticated, useQuery } from "convex/react";
import { useEffect } from "react";
import { api } from "@/convex/_generated/api";
import Cockpit, { stashSessionUri } from "./Cockpit";
import Consent from "./Consent";
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

function Member() {
  const me = useQuery(api.users.viewer, {});
  if (me === undefined) return <Wait text="loading" />;
  if (me === null) return <SignIn />;
  if (me.banned) return <Banned />;
  if (!me.accepted) return <Consent />;
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
