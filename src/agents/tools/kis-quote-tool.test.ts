import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createKisQuoteTool, __testing } from "./kis-quote-tool.js";

describe("kis_quote", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_KIS_MCP_URL;
    delete process.env.KIS_MCP_URL;
  });

  it("normalizes filler tokens out of stock queries", () => {
    expect(__testing.normalizeQuoteQuery("삼성전자 주가 알려줘")).toBe("삼성전자");
    expect(__testing.normalizeQuoteQuery("  MSFT  price  ")).toBe("MSFT");
  });

  it("resolves the KIS MCP URL from ACPX config", () => {
    const cfg = {
      plugins: {
        entries: {
          acpx: {
            config: {
              mcpServers: {
                docs: {
                  command: "npx",
                  args: ["-y", "mcp-remote@latest", "https://docs.example.com/sse"],
                },
                "kis-trade": {
                  command: "npx",
                  args: [
                    "-y",
                    "mcp-remote@latest",
                    "http://kis-trade-mcp:3000/sse",
                    "--allow-http",
                  ],
                },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(__testing.resolveKisMcpUrl(cfg)).toBe("http://kis-trade-mcp:3000/sse");
  });

  it("formats domestic quotes after resolving a stock code", async () => {
    const callTool = vi
      .fn<
        (params: {
          sseUrl: string;
          toolName: string;
          apiType: string;
          params: Record<string, unknown>;
        }) => Promise<unknown>
      >()
      .mockImplementation(async (params) => {
        if (params.toolName === "domestic_stock" && params.apiType === "find_stock_code") {
          return {
            ok: true,
            data: {
              found: true,
              stock_code: "005930",
              stock_name_found: "삼성전자",
              ex: "kospi",
            },
          };
        }
        if (params.toolName === "domestic_stock" && params.apiType === "inquire_price") {
          return {
            data: {
              success: true,
              data: JSON.stringify([
                {
                  stck_prpr: "187900",
                  prdy_vrss: "-2100",
                  prdy_ctrt: "-1.11",
                  stck_oprc: "186600",
                  stck_hgpr: "190000",
                  stck_lwpr: "185900",
                  acml_vol: "20440753",
                },
              ]),
            },
          };
        }
        throw new Error(`unexpected tool call: ${params.toolName}/${params.apiType}`);
      });

    const tool = createKisQuoteTool(
      {
        config: {} as OpenClawConfig,
      },
      { callTool },
    );
    const result = await tool.execute("call-1", {
      commandName: "kis_domestic",
      command: "삼성전자 주가",
    });
    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";

    expect(text).toContain("삼성전자 (005930, KOSPI)");
    expect(text).toContain("현재가: 187,900원");
    expect(text).toContain("전일대비: -2100원 (-1.11%)");
    expect(callTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolName: "domestic_stock",
        apiType: "find_stock_code",
        params: { stock_name: "삼성전자" },
      }),
    );
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolName: "domestic_stock",
        apiType: "inquire_price",
        params: {
          env_dv: "real",
          fid_cond_mrkt_div_code: "J",
          fid_input_iscd: "005930",
        },
      }),
    );
  });

  it("formats overseas quotes after resolving a ticker", async () => {
    const callTool = vi
      .fn<
        (params: {
          sseUrl: string;
          toolName: string;
          apiType: string;
          params: Record<string, unknown>;
        }) => Promise<unknown>
      >()
      .mockImplementation(async (params) => {
        if (params.toolName === "overseas_stock" && params.apiType === "find_stock_code") {
          return {
            ok: true,
            data: {
              found: true,
              stock_code: "MSFT",
              stock_name_found: "마이크로소프트",
              ex: "NAS",
            },
          };
        }
        if (params.toolName === "overseas_stock" && params.apiType === "price") {
          return {
            data: {
              success: true,
              data: JSON.stringify([
                {
                  last: "403.9350",
                  diff: "0.9450",
                  rate: "-0.23",
                  base: "404.8800",
                  pvol: "25512139",
                  tvol: "6551407",
                },
              ]),
            },
          };
        }
        throw new Error(`unexpected tool call: ${params.toolName}/${params.apiType}`);
      });

    const tool = createKisQuoteTool(
      {
        config: {} as OpenClawConfig,
      },
      { callTool },
    );
    const result = await tool.execute("call-2", {
      commandName: "kis_overseas",
      command: "마이크로소프트 주가",
    });
    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";

    expect(text).toContain("마이크로소프트 (MSFT, NAS)");
    expect(text).toContain("현재가: 403.9350 USD");
    expect(text).toContain("전일대비: -0.945 USD (-0.23%)");
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolName: "overseas_stock",
        apiType: "price",
        params: {
          auth: "",
          excd: "NAS",
          symb: "MSFT",
          env_dv: "real",
          tr_cont: "",
        },
      }),
    );
  });

  it("surfaces lookup guidance when a stock cannot be found", async () => {
    const tool = createKisQuoteTool(
      {
        config: {} as OpenClawConfig,
      },
      {
        callTool: async () => ({
          ok: false,
          message: "종목을 찾지 못했습니다.",
          suggestions: ["티커로 다시 시도", "한글 종목명으로 다시 시도"],
        }),
      },
    );
    const result = await tool.execute("call-3", {
      market: "overseas",
      query: "Microsoft Corp",
    });
    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";

    expect(text).toContain("종목을 찾지 못했습니다.");
    expect(text).toContain("- 티커로 다시 시도");
  });
});
