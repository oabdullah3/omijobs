import { ctGoodJobsAdapter } from "./portals/ctgoodjobs.js";
import { gradConnectionAdapter } from "./portals/gradconnection.js";
import { jobsDbAdapter } from "./portals/jobsdb.js";
import { linkedInAdapter } from "./portals/linkedin.js";
import type { Adapter } from "./types.js";

/** Single place to register adapters. Add new portals/ATS here as they're built. */
export const adapters: Adapter[] = [ctGoodJobsAdapter, gradConnectionAdapter, jobsDbAdapter, linkedInAdapter];
