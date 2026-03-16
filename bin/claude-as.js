#!/usr/bin/env node

import { main } from "../src/claude/cli.js";

main(process.argv.slice(2)).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
