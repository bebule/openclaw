#!/usr/bin/env node

import { printJson, requestAdapterJson, SmartThingsCliError } from "./_smartthings-client.js";

async function main() {
  const payload = await requestAdapterJson("GET", "/devices");
  printJson(payload);
}

main().catch((error) => {
  if (error instanceof SmartThingsCliError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(error.stack || error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
