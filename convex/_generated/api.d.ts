/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as auth from "../auth.js";
import type * as broadcast from "../broadcast.js";
import type * as community from "../community.js";
import type * as connections from "../connections.js";
import type * as facts from "../facts.js";
import type * as http from "../http.js";
import type * as inbound from "../inbound.js";
import type * as ingest from "../ingest.js";
import type * as interns from "../interns.js";
import type * as outbox from "../outbox.js";
import type * as questions from "../questions.js";
import type * as run from "../run.js";
import type * as seed from "../seed.js";
import type * as send from "../send.js";
import type * as slack from "../slack.js";
import type * as sources from "../sources.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  auth: typeof auth;
  broadcast: typeof broadcast;
  community: typeof community;
  connections: typeof connections;
  facts: typeof facts;
  http: typeof http;
  inbound: typeof inbound;
  ingest: typeof ingest;
  interns: typeof interns;
  outbox: typeof outbox;
  questions: typeof questions;
  run: typeof run;
  seed: typeof seed;
  send: typeof send;
  slack: typeof slack;
  sources: typeof sources;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
