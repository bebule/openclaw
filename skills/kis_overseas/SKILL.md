---
name: kis_overseas
description: Query a KIS overseas stock quote by name or ticker.
user-invocable: true
disable-model-invocation: true
command-dispatch: tool
command-tool: kis_quote
command-arg-mode: raw
---

# KIS Overseas Quote

Use `/kis_overseas <종목명|티커>` to resolve an overseas stock and fetch the latest quote through KIS MCP.
