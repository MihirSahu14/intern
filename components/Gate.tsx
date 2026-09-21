"use client";

import { AuthLoading, Authenticated, Unauthenticated, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Cockpit from "./Cockpit";
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
  if (me.banned) return <Wait text="this account is blocked from the public brain" />;
  if (!me.accepted) return <Consent />;
  return <Cockpit me={{ userId: me.userId, handle: me.handle, image: me.image }} />;
}
