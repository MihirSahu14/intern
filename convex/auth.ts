import GitHub from "@auth/core/providers/github";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * GitHub only. One click, a real identity per person (so caps can't be dodged
 * with throwaway emails), and no app review. Email is deliberately not stored:
 * the brain is public and nothing here needs it.
 *
 * Reads AUTH_GITHUB_ID / AUTH_GITHUB_SECRET from the deployment env.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    GitHub({
      profile(p) {
        return {
          id: String(p.id),
          name: p.name ?? p.login,
          image: p.avatar_url,
          handle: p.login,
          githubId: String(p.id),
        };
      },
    }),
  ],
});
