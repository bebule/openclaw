import { describe, expect, it } from "vitest";
import smartThingsPlugin, { parseSmartThingsPluginConfig } from "./index.js";
import manifest from "./openclaw.plugin.json";

describe("smartthings plugin definition", () => {
  it("keeps exported metadata aligned with the manifest source of truth", () => {
    expect(smartThingsPlugin.id).toBe(manifest.id);
    expect(smartThingsPlugin.name).toBe(manifest.name);
    expect(smartThingsPlugin.description).toBe(manifest.description);
    expect(smartThingsPlugin.configSchema?.jsonSchema).toEqual(manifest.configSchema);
    expect(smartThingsPlugin.configSchema?.uiHints).toEqual(manifest.uiHints);
  });

  it("normalizes plugin config values before runtime use", () => {
    expect(
      parseSmartThingsPluginConfig({
        adapterUrl: "  https://gateway.example.test/openclaw  ",
        adapterToken: "  adapter-token  ",
        ignored: "value",
      }),
    ).toEqual({
      adapterUrl: "https://gateway.example.test/openclaw",
      adapterToken: "adapter-token",
    });

    expect(parseSmartThingsPluginConfig({ adapterUrl: "   ", adapterToken: "" })).toEqual({});
  });
});
