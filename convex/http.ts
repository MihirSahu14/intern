import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { callback } from "./connections";

const http = httpRouter();
auth.addHttpRoutes(http);
http.route({ path: "/composio/callback", method: "GET", handler: callback });
export default http;
