import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { webhook } from "./inbound";

const http = httpRouter();
auth.addHttpRoutes(http);
// Composio trigger events (Slack 🧠, the Gmail Intern label), signed with COMPOSIO_WEBHOOK_SECRET.
http.route({ path: "/composio/webhook", method: "POST", handler: webhook });
export default http;
