#!/usr/bin/env node

import {
  buildCommandInvocation,
  printJson,
  requestAdapterJson,
  SmartThingsCliError,
} from "./_smartthings-client.js";

async function main() {
  const invocation = buildCommandInvocation(process.argv.slice(2));
  const commandBody = buildCommandBody(invocation);
  const payload = await requestAdapterJson(
    "POST",
    `/devices/${encodeURIComponent(invocation.deviceId)}/commands`,
    commandBody,
  );
  printJson(payload);
}

function buildCommandBody(invocation) {
  const command = {
    capability: invocation.capability,
    command: invocation.command,
  };

  if (invocation.component) {
    command.component = invocation.component;
  }
  if (invocation.arguments !== undefined) {
    command.arguments = invocation.arguments;
  }

  return { commands: [command] };
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
