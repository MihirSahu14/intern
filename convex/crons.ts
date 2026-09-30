import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// GitHub sources are read again once a day. Slack arrives live; once a day
// each channel is checked still public and open (a channel made private sends no event).
crons.interval("refresh github sources", { hours: 24 }, internal.ingest.refreshRepos, {});
crons.interval("check slack channels", { hours: 24 }, internal.ingest.sweepChannels, {});
// Uploaded files no source kept.
crons.interval("sweep unclaimed uploads", { hours: 24 }, internal.sources.sweepUploads, {});

export default crons;
