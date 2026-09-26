import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// GitHub sources are read again once a day. Slack arrives live and needs no cron.
crons.interval("refresh github sources", { hours: 24 }, internal.ingest.refreshRepos, {});

export default crons;
