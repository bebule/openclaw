---
name: kis_domestic
description: Query a KIS domestic stock quote by name or code.
user-invocable: true
disable-model-invocation: true
command-dispatch: tool
command-tool: kis_quote
command-arg-mode: raw
---

# KIS Domestic Quote

Use `/kis_domestic <종목명|종목코드>` to resolve a Korean stock and fetch the latest quote through KIS MCP.
