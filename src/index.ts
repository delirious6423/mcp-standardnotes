#!/usr/bin/env node
import { logger } from "./security/logger.js";
import { startServer } from "./server.js";
import { configureStateDirectory } from "./config.js";

configureStateDirectory().then(startServer).catch((err) => {
  logger.error("Fatal startup error", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
