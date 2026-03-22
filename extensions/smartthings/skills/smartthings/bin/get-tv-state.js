#!/usr/bin/env node

import {
  SmartThingsCliError,
  printJson,
  requestAdapterJson,
  summarizeDeviceStatus,
} from "./_smartthings-client.js";

async function main() {
  const deviceId = process.argv[2]?.trim();
  if (!deviceId) {
    throw new SmartThingsCliError(
      "Missing deviceId.\nUsage: node {baseDir}/bin/get-tv-state.js <deviceId>",
    );
  }

  const payload = await requestAdapterJson(
    "GET",
    `/devices/${encodeURIComponent(deviceId)}/status`,
  );
  printJson(summarizeDeviceStatus(payload));
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
