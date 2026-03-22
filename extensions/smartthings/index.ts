import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import manifest from "./openclaw.plugin.json";

export type SmartThingsPluginConfig = {
  adapterToken?: string;
  adapterUrl?: string;
};

export function parseSmartThingsPluginConfig(value: unknown): SmartThingsPluginConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const adapterUrl =
    typeof raw.adapterUrl === "string" && raw.adapterUrl.trim().length > 0
      ? raw.adapterUrl.trim()
      : undefined;
  const adapterToken =
    typeof raw.adapterToken === "string" && raw.adapterToken.trim().length > 0
      ? raw.adapterToken.trim()
      : undefined;
  return {
    ...(adapterUrl ? { adapterUrl } : {}),
    ...(adapterToken ? { adapterToken } : {}),
  };
}

const smartThingsPluginConfigSchema = {
  jsonSchema: manifest.configSchema,
  uiHints: manifest.uiHints,
  parse: parseSmartThingsPluginConfig,
};

const smartThingsPlugin = {
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: smartThingsPluginConfigSchema,
  register(_api: OpenClawPluginApi) {
    // Packaging and plugin-shipped skills are declared in openclaw.plugin.json.
    // Milestone 1 intentionally keeps runtime registration empty and uses the external adapter.
  },
} satisfies OpenClawPluginDefinition;

export default smartThingsPlugin;
