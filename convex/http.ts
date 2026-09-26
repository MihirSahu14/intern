import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { webhook } from "./inbound";
import { events } from "./slack";

const http = httpRouter();
auth.addHttpRoutes(http);
// Composio trigger events (Slack 🧠, the Gmail Intern label), signed with COMPOSIO_WEBHOOK_SECRET.
http.route({ path: "/composio/webhook", method: "POST", handler: webhook });
// The community Slack, through the "Intern Brain" app, signed with SLACK_BRAIN_SIGNING_SECRET.
http.route({ path: "/slack/events", method: "POST", handler: events });
export default http;
