#!/usr/bin/env node
// obs-websocket-js uses the `debug` package, which prints every incoming
// message (including settings that hold stream keys) when DEBUG matches.
// Clear it before anything loads that package.
delete process.env.DEBUG;

const { main } = await import("./main.ts");
process.exitCode = await main(process.argv.slice(2));
