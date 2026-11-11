#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { login } from "./login.js";
import { createServer } from "./server.js";

// stdout is the protocol channel: route stray console output to stderr.
console.log = console.error;
console.info = console.error;

if (process.argv[2] === "login") process.exit(await login());

await createServer().connect(new StdioServerTransport());
