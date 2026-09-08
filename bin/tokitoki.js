#!/usr/bin/env bun
// Published tarballs contain the built dist/cli.js; a source checkout may not
// have been built yet, so fall back to running TS directly via bun.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const built = `${here}/../dist/cli.js`;
const entry = existsSync(built) ? built : `${here}/../src/cli.ts`;
const { main } = await import(entry);
void main(process.argv.slice(2));
