import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { isRecord } from "../../utils.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, ToolInputError, readStringParam } from "./common.js";

const KIS_MARKETS = ["domestic", "overseas"] as const;
const KIS_MCP_FALLBACK_URL = "http://kis-trade-mcp:3000/sse";
const KIS_MCP_TIMEOUT_MS = 90_000;
const KIS_QUERY_NOISE_TOKENS = new Set([
  "주가",
  "가격",
  "시세",
  "조회",
  "검색",
  "종목",
  "종목명",
  "종목코드",
  "코드",
  "티커",
  "ticker",
  "stock",
  "stocks",
  "quote",
  "quotes",
  "price",
  "prices",
  "보여줘",
  "보여줘요",
  "알려줘",
  "알려줘요",
  "부탁해",
  "부탁해요",
  "좀",
  "현재가",
]);

const KisQuoteToolSchema = Type.Object({
  market: Type.Optional(stringEnum(KIS_MARKETS)),
  query: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  commandName: Type.Optional(Type.String()),
  skillName: Type.Optional(Type.String()),
});

type KisMarket = (typeof KIS_MARKETS)[number];

type KisQuoteToolDeps = {
  callTool?: (params: {
    sseUrl: string;
    toolName: string;
    apiType: string;
    params: Record<string, unknown>;
  }) => Promise<unknown>;
};

type KisLookupSuccess = {
  tool_name?: string;
  search_value?: string;
  found?: boolean;
  stock_code?: string;
  stock_name_found?: string;
  ex?: string;
  match_type?: string;
  message?: string;
  usage_guide?: string;
  next_step?: string;
};

type KisQuoteSuccessEnvelope = {
  success?: boolean;
  api_type?: string;
  params?: Record<string, unknown>;
  message?: string;
  execution_time?: string;
  data?: string;
  error?: string;
};

function trimPunctuation(value: string): string {
  return value.replace(/^[\s"'`([{,.:;!?]+|[\s"'`)\]},.:;!?]+$/g, "");
}

function normalizeQuoteQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const cleanedTokens = trimmed
    .split(/\s+/)
    .map((token) => trimPunctuation(token))
    .filter(Boolean);
  const filteredTokens = cleanedTokens.filter(
    (token) => !KIS_QUERY_NOISE_TOKENS.has(token.toLowerCase()),
  );
  return (filteredTokens.length > 0 ? filteredTokens : cleanedTokens).join(" ").trim();
}

function formatIntegerString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 0,
  }).format(num);
}

function formatScalarString(value: unknown, fallback = "-"): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return fallback;
}

function formatSignedDecimalString(value: number, fractionDigits = 4): string {
  const abs = Math.abs(value);
  const fixed = abs.toFixed(fractionDigits);
  const text = fractionDigits > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
  return `${value < 0 ? "-" : value > 0 ? "+" : ""}${text}`;
}

function formatRateString(value: number, fractionDigits = 2): string {
  const abs = Math.abs(value)
    .toFixed(fractionDigits)
    .replace(/\.?0+$/, "");
  return `${value < 0 ? "-" : value > 0 ? "+" : ""}${abs}%`;
}

function normalizeSseUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/sse";
  }
  return parsed.toString();
}

function extractConfiguredMcpUrl(cfg: OpenClawConfig): string | null {
  const envUrl = process.env.OPENCLAW_KIS_MCP_URL ?? process.env.KIS_MCP_URL;
  if (typeof envUrl === "string" && envUrl.trim()) {
    return normalizeSseUrl(envUrl);
  }

  const pluginEntries = isRecord(cfg.plugins?.entries) ? cfg.plugins.entries : null;
  const acpxEntry = pluginEntries && isRecord(pluginEntries.acpx) ? pluginEntries.acpx : null;
  const acpxConfig = acpxEntry && isRecord(acpxEntry.config) ? acpxEntry.config : null;
  const mcpServers = acpxConfig && isRecord(acpxConfig.mcpServers) ? acpxConfig.mcpServers : null;
  if (!mcpServers) {
    return null;
  }

  let bestUrl: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [name, value] of Object.entries(mcpServers)) {
    if (!isRecord(value)) {
      continue;
    }
    const args = Array.isArray(value.args)
      ? value.args.filter((arg) => typeof arg === "string")
      : [];
    const urlArg = args.find((arg) => /^https?:\/\//i.test(arg.trim()));
    if (!urlArg) {
      continue;
    }
    const normalizedUrl = normalizeSseUrl(urlArg);
    const haystack = [name, value.command, ...args]
      .filter((entry) => typeof entry === "string")
      .join(" ")
      .toLowerCase();
    let score = 1;
    if (haystack.includes("kis")) {
      score += 10;
    }
    if (haystack.includes("kis-trade-mcp")) {
      score += 20;
    }
    if (score > bestScore) {
      bestScore = score;
      bestUrl = normalizedUrl;
    }
  }
  return bestUrl;
}

function resolveKisMcpUrl(cfg: OpenClawConfig): string {
  return extractConfiguredMcpUrl(cfg) ?? KIS_MCP_FALLBACK_URL;
}

function createSseParser(onEvent: (event: { event: string; data: string }) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    while (true) {
      const delimiterIndex = buffer.indexOf("\n\n");
      if (delimiterIndex < 0) {
        break;
      }
      const rawEvent = buffer.slice(0, delimiterIndex);
      buffer = buffer.slice(delimiterIndex + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of rawEvent.split(/\n/)) {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
      if (dataLines.length > 0) {
        onEvent({ event, data: dataLines.join("\n") });
      }
    }
  };
}

async function postJson(url: string, body: unknown, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`KIS MCP POST failed (${response.status})`);
  }
}

function extractStructuredContent(response: unknown): unknown {
  if (!isRecord(response)) {
    return response;
  }
  const result = isRecord(response.result) ? response.result : null;
  if (result && result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const firstContent =
    result && Array.isArray(result.content) && result.content.length > 0 ? result.content[0] : null;
  if (isRecord(firstContent) && typeof firstContent.text === "string") {
    try {
      return JSON.parse(firstContent.text);
    } catch {
      return firstContent.text;
    }
  }
  return response;
}

async function callKisMcpTool(params: {
  sseUrl: string;
  toolName: string;
  apiType: string;
  params: Record<string, unknown>;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KIS_MCP_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(params.sseUrl, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`KIS MCP SSE failed (${response.status})`);
    }
    if (!response.body) {
      throw new Error("KIS MCP SSE body missing");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let endpointUrl: string | null = null;
    let initializePosted = false;
    let initialized = false;
    let toolPosted = false;
    let toolResponse: unknown = null;

    const parser = createSseParser((event) => {
      if (event.event === "endpoint") {
        endpointUrl = new URL(event.data, params.sseUrl).toString();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isRecord(parsed)) {
        return;
      }
      if (parsed.id === 0 && isRecord(parsed.result)) {
        initialized = true;
        return;
      }
      if (parsed.id === 1) {
        toolResponse = parsed;
      }
    });

    while (toolResponse === null) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      parser(decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n"));

      if (endpointUrl && !initializePosted) {
        initializePosted = true;
        await postJson(
          endpointUrl,
          {
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: {
                name: "openclaw",
                version: "2026.3.11",
              },
            },
          },
          controller.signal,
        );
      }

      if (endpointUrl && initialized && !toolPosted) {
        toolPosted = true;
        await postJson(
          endpointUrl,
          {
            jsonrpc: "2.0",
            method: "notifications/initialized",
          },
          controller.signal,
        );
        await postJson(
          endpointUrl,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: params.toolName,
              arguments: {
                api_type: params.apiType,
                params: params.params,
              },
            },
          },
          controller.signal,
        );
      }
    }

    if (toolResponse === null) {
      throw new Error("Timed out waiting for KIS MCP response");
    }
    if (isRecord(toolResponse) && isRecord(toolResponse.error)) {
      const message =
        typeof toolResponse.error.message === "string"
          ? toolResponse.error.message
          : "KIS MCP request failed";
      throw new Error(message);
    }
    return extractStructuredContent(toolResponse);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("KIS MCP request timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

function resolveMarketFromDispatch(
  market: string | undefined,
  commandName: string | undefined,
  skillName: string | undefined,
): KisMarket {
  const normalizedMarket = market?.trim().toLowerCase();
  if (normalizedMarket === "domestic" || normalizedMarket === "overseas") {
    return normalizedMarket;
  }
  const haystack = `${commandName ?? ""} ${skillName ?? ""}`.toLowerCase();
  if (haystack.includes("domestic")) {
    return "domestic";
  }
  if (haystack.includes("overseas")) {
    return "overseas";
  }
  throw new ToolInputError("market required");
}

function parseJsonArrayRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("KIS quote payload missing");
  }
  const parsed = JSON.parse(raw.trim());
  if (!Array.isArray(parsed) || parsed.length === 0 || !isRecord(parsed[0])) {
    throw new Error("Unexpected KIS quote payload");
  }
  return parsed[0];
}

function formatLookupFailure(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof payload.message === "string" && payload.message.trim()) {
    lines.push(payload.message.trim());
  } else {
    lines.push("종목을 찾지 못했습니다.");
  }
  const suggestions = Array.isArray(payload.suggestions)
    ? payload.suggestions.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  if (suggestions.length > 0) {
    lines.push("");
    lines.push("다음처럼 다시 입력해보세요:");
    for (const suggestion of suggestions.slice(0, 4)) {
      lines.push(`- ${suggestion}`);
    }
  }
  return lines.join("\n");
}

function formatDomesticQuote(params: {
  query: string;
  lookup: KisLookupSuccess;
  record: Record<string, unknown>;
}): string {
  const headerName = params.lookup.stock_name_found ?? params.query;
  const headerCode = params.lookup.stock_code ?? "";
  const exchange = typeof params.lookup.ex === "string" ? params.lookup.ex.toUpperCase() : "";
  const price =
    formatIntegerString(params.record.stck_prpr) ?? formatScalarString(params.record.stck_prpr);
  const diffValue = Number(params.record.prdy_vrss ?? 0);
  const diff = Number.isFinite(diffValue)
    ? formatSignedDecimalString(diffValue, 0)
    : formatScalarString(params.record.prdy_vrss);
  const rateValue = Number(params.record.prdy_ctrt ?? 0);
  const rate = Number.isFinite(rateValue)
    ? formatRateString(rateValue, 2)
    : formatScalarString(params.record.prdy_ctrt);
  const open = formatIntegerString(params.record.stck_oprc) ?? "-";
  const high = formatIntegerString(params.record.stck_hgpr) ?? "-";
  const low = formatIntegerString(params.record.stck_lwpr) ?? "-";
  const volume = formatIntegerString(params.record.acml_vol) ?? "-";

  const lines = [
    `${headerName} (${headerCode}${exchange ? `, ${exchange}` : ""})`,
    `현재가: ${price}원`,
    `전일대비: ${diff}원 (${rate})`,
    `시가/고가/저가: ${open}원 / ${high}원 / ${low}원`,
    `거래량: ${volume}주`,
  ];
  return lines.join("\n");
}

function resolveOverseasCurrency(exchange: string | undefined): string | undefined {
  switch ((exchange ?? "").toUpperCase()) {
    case "NAS":
    case "NYS":
    case "AMS":
      return "USD";
    case "TSE":
      return "JPY";
    case "HKS":
      return "HKD";
    case "SHS":
    case "SZS":
      return "CNY";
    default:
      return undefined;
  }
}

function formatOverseasQuote(params: {
  query: string;
  lookup: KisLookupSuccess;
  record: Record<string, unknown>;
}): string {
  const headerName = params.lookup.stock_name_found ?? params.query;
  const headerCode = params.lookup.stock_code ?? "";
  const exchange = typeof params.lookup.ex === "string" ? params.lookup.ex.toUpperCase() : "";
  const currency = resolveOverseasCurrency(exchange);
  const current = formatScalarString(params.record.last);
  const diffRaw = Number(params.record.diff ?? 0);
  const rateRaw = Number(params.record.rate ?? 0);
  const signedDiff =
    Number.isFinite(diffRaw) && Number.isFinite(rateRaw)
      ? rateRaw < 0
        ? -Math.abs(diffRaw)
        : diffRaw
      : NaN;
  const diff = Number.isFinite(signedDiff)
    ? formatSignedDecimalString(signedDiff, 4)
    : formatScalarString(params.record.diff);
  const rate = Number.isFinite(rateRaw)
    ? formatRateString(rateRaw, 2)
    : formatScalarString(params.record.rate);
  const base = formatScalarString(params.record.base);
  const prevVolume = formatIntegerString(params.record.pvol) ?? "-";
  const dayVolume = formatIntegerString(params.record.tvol) ?? "-";
  const suffix = currency ? ` ${currency}` : "";

  const lines = [
    `${headerName} (${headerCode}${exchange ? `, ${exchange}` : ""})`,
    `현재가: ${current}${suffix}`,
    `전일대비: ${diff}${suffix} (${rate})`,
    `기준가: ${base}${suffix}`,
    `거래량(전일/당일): ${prevVolume} / ${dayVolume}`,
  ];
  return lines.join("\n");
}

async function runKisQuote(params: {
  market: KisMarket;
  query: string;
  sseUrl: string;
  callTool: NonNullable<KisQuoteToolDeps["callTool"]>;
}): Promise<{
  text: string;
  details: Record<string, unknown>;
}> {
  const lookupToolName = params.market === "domestic" ? "domestic_stock" : "overseas_stock";
  const lookupRaw = await params.callTool({
    sseUrl: params.sseUrl,
    toolName: lookupToolName,
    apiType: "find_stock_code",
    params: { stock_name: params.query },
  });
  const lookup = isRecord(lookupRaw) ? lookupRaw : {};
  if (lookup.ok !== true || !isRecord(lookup.data) || lookup.data.found !== true) {
    return {
      text: formatLookupFailure(lookup),
      details: {
        market: params.market,
        query: params.query,
        lookup,
      },
    };
  }

  const lookupData = lookup.data as KisLookupSuccess;
  const stockCode = typeof lookupData.stock_code === "string" ? lookupData.stock_code.trim() : "";
  if (!stockCode) {
    throw new Error("KIS lookup did not return a stock code");
  }

  if (params.market === "domestic") {
    const quoteRaw = await params.callTool({
      sseUrl: params.sseUrl,
      toolName: "domestic_stock",
      apiType: "inquire_price",
      params: {
        env_dv: "real",
        fid_cond_mrkt_div_code: "J",
        fid_input_iscd: stockCode,
      },
    });
    const quote =
      isRecord(quoteRaw) && isRecord(quoteRaw.data)
        ? (quoteRaw.data as KisQuoteSuccessEnvelope)
        : {};
    if (quote.success !== true) {
      throw new Error(
        typeof quote.error === "string" && quote.error.trim()
          ? quote.error.trim()
          : "국내 주식 시세 조회에 실패했습니다.",
      );
    }
    const record = parseJsonArrayRecord(quote.data);
    return {
      text: formatDomesticQuote({
        query: params.query,
        lookup: lookupData,
        record,
      }),
      details: {
        market: params.market,
        query: params.query,
        lookup: lookupData,
        quote: record,
      },
    };
  }

  const exchange =
    typeof lookupData.ex === "string" && lookupData.ex.trim()
      ? lookupData.ex.trim().toUpperCase()
      : "NAS";
  const quoteRaw = await params.callTool({
    sseUrl: params.sseUrl,
    toolName: "overseas_stock",
    apiType: "price",
    params: {
      auth: "",
      excd: exchange,
      symb: stockCode,
      env_dv: "real",
      tr_cont: "",
    },
  });
  const quote =
    isRecord(quoteRaw) && isRecord(quoteRaw.data) ? (quoteRaw.data as KisQuoteSuccessEnvelope) : {};
  if (quote.success !== true) {
    throw new Error(
      typeof quote.error === "string" && quote.error.trim()
        ? quote.error.trim()
        : "해외 주식 시세 조회에 실패했습니다.",
    );
  }
  const record = parseJsonArrayRecord(quote.data);
  return {
    text: formatOverseasQuote({
      query: params.query,
      lookup: lookupData,
      record,
    }),
    details: {
      market: params.market,
      query: params.query,
      lookup: lookupData,
      quote: record,
    },
  };
}

export function createKisQuoteTool(
  options?: {
    config?: OpenClawConfig;
  },
  deps?: KisQuoteToolDeps,
): AnyAgentTool {
  const callTool = deps?.callTool ?? callKisMcpTool;
  return {
    label: "KIS Quote",
    name: "kis_quote",
    description:
      "Resolve a domestic stock code or overseas ticker through KIS MCP, then fetch the latest quote deterministically.",
    parameters: KisQuoteToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const market = resolveMarketFromDispatch(
        readStringParam(params, "market"),
        readStringParam(params, "commandName"),
        readStringParam(params, "skillName"),
      );
      const rawQuery =
        readStringParam(params, "query") ??
        readStringParam(params, "command", { allowEmpty: true }) ??
        "";
      const query = normalizeQuoteQuery(rawQuery);
      if (!query) {
        throw new ToolInputError("query required");
      }
      const cfg = options?.config ?? loadConfig();
      const sseUrl = resolveKisMcpUrl(cfg);
      const result = await runKisQuote({
        market,
        query,
        sseUrl,
        callTool,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  };
}

export const __testing = {
  KIS_MCP_FALLBACK_URL,
  normalizeQuoteQuery,
  resolveKisMcpUrl,
  resolveMarketFromDispatch,
  formatDomesticQuote,
  formatOverseasQuote,
  runKisQuote,
};
