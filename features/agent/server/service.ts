import { readFile } from "node:fs/promises";
import { dataPath, jsonResponse } from "@/lib/server/files";
import { editorSchemaResponse } from "@/lib/server/editorSchema";
import { errorMessage, isHttpUrl, isJsonContentType } from "@/lib/server/http";
import { searchDatasetCatalog } from "@/features/dataset/server/service";
import { getToolData } from "@/features/tool/server/repository";
import { agentItemEditorFields, agentSearchSourceEditorFields } from "../agent.schema";
import type { AgentModelProvider } from "../agent.schema";
import { claudeProvider } from "./providers/claude";
import { geminiProvider } from "./providers/gemini";
import { openAiProvider } from "./providers/openai";
import { getAgentSearchSources, getAgentSessions, getGlobalInstruction, saveAgentData, saveAgentSearchSources, saveAgentSessions, saveGlobalInstruction } from "./repository";

const DEFAULT_AGENT_SYSTEM_INSTRUCTION = "You are a GIS research assistant.";

const datasetPath = dataPath("features", "dataset.json");
const searchRegistryPath = dataPath("search.json");
const AGENT_MODEL_PROVIDERS = [
  geminiProvider,
  openAiProvider,
  claudeProvider
];

export async function listAgentSessions() {
  return jsonResponse(await getAgentSessions());
}

export async function listAgentSessionItems() {
  const registry: any = await getAgentSessions();
  const sessions = Array.isArray(registry?.sessions) ? registry.sessions : [];
  return jsonResponse(sessions.map((session: any) => ({
    ...session,
    name: session.name || session.title || "Untitled Chat",
    description: session.description || "Chat session"
  })));
}

export function getAgentEditorSchema(target: string) {
  return editorSchemaResponse(target, {
    item: agentItemEditorFields,
    searchSource: agentSearchSourceEditorFields
  });
}

export async function listAgentSearchSources() {
  return jsonResponse(await getAgentSearchSources());
}

export async function updateAgentSessions(sessions: unknown[]) {
  await saveAgentSessions(sessions);
  return jsonResponse({ ok: true });
}

export async function updateAgentData(data: unknown) {
  await saveAgentData(data);
  return jsonResponse({ ok: true });
}

export async function updateAgentSearchSources(sources: unknown[]) {
  await saveAgentSearchSources(sources);
  return jsonResponse({ ok: true });
}

export async function readAgentInstruction() {
  return jsonResponse({ instruction: await getGlobalInstruction() });
}

export async function updateAgentInstruction(instruction: string) {
  await saveGlobalInstruction(instruction);
  return jsonResponse({ ok: true });
}

export async function handleAgentChat(request: Request) {
  const body = await request.json().catch(() => null);
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const provider = getAgentModelProvider(body?.provider);
  const model = typeof body?.model === "string" && body.model.trim()
    ? body.model.trim()
    : provider.defaultModel;

  if (!apiKey) {
    return jsonResponse({ error: `${provider.apiKeyLabel} is required.` }, { status: 400 });
  }

  const { contents, messages, systemInstruction } = body || {};
  const appMessages = normalizeAppMessages(messages);
  const legacyContents = Array.isArray(contents) ? contents : [];

  if (appMessages.length === 0 && legacyContents.length === 0) {
    return jsonResponse({ error: "messages must be a non-empty array." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "ready" })}\n\n`));
      void runAgentChat({
        apiKey,
        provider,
        model,
        appMessages,
        legacyContents,
        systemInstruction,
        send: (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      })
        .catch((error) => {
          console.error(`[Agent] ${provider.label} request failed`, {
            message: errorMessage(error),
            status: error?.status,
            upstreamBody: error?.upstreamBody
          });
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "error",
            message: provider.errorResponseMessage(error),
            detail: errorMessage(error)
          })}\n\n`));
        })
        .finally(() => controller.close());
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    }
  });
}

function getAgentModelProvider(providerId: string | null | undefined): AgentModelProvider {
  const normalized = String(providerId || "").trim().toLowerCase();
  return AGENT_MODEL_PROVIDERS.find((provider) => provider.id === normalized) || geminiProvider;
}

async function runAgentChat({ apiKey, provider, model, appMessages, legacyContents, systemInstruction, send }: any) {
  let flatCatalogs: any[] = [];
  let datasetSources: any[] = [];
  const toolItems = await getToolData();

  try {
    const registry = JSON.parse(await readFile(searchRegistryPath, "utf8"));
    flatCatalogs = Array.isArray(registry)
      ? registry.filter((item: any) => (item.feature || item.activity) === "dataset").map((item: any) => ({ id: item.id, name: item.name, url: item.url, type: item.type }))
      : [];
  } catch {}

  try {
    datasetSources = JSON.parse(await readFile(datasetPath, "utf8"));
  } catch {}

  const globalInstruction = (typeof systemInstruction === "string" && systemInstruction.trim())
    ? systemInstruction.trim()
    : DEFAULT_AGENT_SYSTEM_INSTRUCTION;
  const baseInstruction = globalInstruction;

  const interactionTools = toInteractionTools(toolItems);
  const seenIds = new Set();
  let maxTurns = 10;

  async function executeAgentTool(name: string, args: any = {}) {
    if (name === "list_catalogs") {
      return { catalogs: flatCatalogs };
    }

    if (name === "list_sources") {
      const summary = datasetSources
        .filter((s) => !s.isDeleted)
        .map((s) => ({
          id: s.id,
          name: s.name,
          description: (s.description || "").slice(0, 300),
          type: s.type,
          queryUrl: s.queryUrl || getSourceQueryBaseUrl(s),
          defaultParams: sourceParamsToObject(s.defaultParams || [])
        }));
      return { sources: summary };
    }

    if (name === "query_source") {
      try {
        const result = await queryConfiguredSource(datasetSources, args.sourceId, args.params || {});
        send({ type: "record", record: createSourceQueryRecord(result) });
        return result;
      } catch (error) {
        console.error("[Agent source query] Failed:", errorMessage(error));
        return { error: errorMessage(error) };
      }
    }

    if (name !== "search_catalog") {
      return { error: `Unknown tool: ${name}` };
    }

    const requestedCatalogUrl = args.catalogUrl || args.hubUrl;
    const catalog = flatCatalogs.find((catalog) => catalog.url === requestedCatalogUrl || requestedCatalogUrl?.startsWith(catalog.url));
    const catalogUrl = catalog?.url || requestedCatalogUrl;
    const catalogType = catalog?.type || "arcgis";
    const catalogName = catalog?.name || catalogUrl;

    if (!catalogUrl) {
      return { error: "catalogUrl is required.", results: [], count: 0 };
    }

    send({ type: "search_start", query: args.query, catalogName, catalogUrl });

    try {
      const results = await searchDatasetCatalog(
        { url: catalogUrl, type: catalogType === "socrata" ? "socrata" : "arcgis", name: catalogName },
        args.query,
        8,
        { bbox: args.bbox }
      );

      for (const item of results) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          send({ type: "result", item: { ...item, catalogName, portalType: catalogType } });
        }
      }

      return {
        results: results.map((r: any) => ({ id: r.id, title: r.title, snippet: (r.snippet || "").slice(0, 200) })),
        count: results.length
      };
    } catch (error) {
      console.error("[Agent catalog search] Failed:", errorMessage(error));
      send({ type: "search_error", query: args.query, catalogName, message: errorMessage(error) });
      return { error: errorMessage(error), results: [], count: 0 };
    }
  }

  function buildInteractionBody(input: any, previousInteractionId: string | null = null) {
    return {
      model,
      input,
      ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
      tools: interactionTools,
      system_instruction: baseInstruction,
      generation_config: { temperature: 0.7, max_output_tokens: 2048 }
    };
  }

  const interactionInput = appMessages.length > 0
    ? appMessagesToInteractionInput(appMessages)
    : contentHistoryToInteractionInput(legacyContents);
  let interaction = await provider.createInteraction(apiKey, buildInteractionBody(interactionInput));

  while (maxTurns-- > 0) {
    const functionCalls = getInteractionFunctionCalls(interaction);
    const text = getInteractionOutputText(interaction);

    if (functionCalls.length === 0) {
      if (!text) send({ type: "error", message: provider.emptyResponseMessage });
      for (let i = 0; i < text.length; i += 60) send({ type: "text", delta: text.slice(i, i + 60) });
      break;
    }

    const functionResults = [];
    for (const call of functionCalls) {
      const result = await executeAgentTool(call.name, call.args);
      functionResults.push({
        type: "function_result",
        call_id: call.id,
        name: call.name,
        result: [{ type: "text", text: JSON.stringify(result) }]
      });
    }

    if (functionResults.length === 0) break;
    interaction = await provider.createInteraction(apiKey, buildInteractionBody(
      functionResults.length === 1 ? functionResults[0] : functionResults,
      interaction.id
    ));
  }
}

function contentHistoryToInteractionInput(contents: any[]) {
  const turns = (contents || []).map((turn) => {
    const role = turn.role === "model" ? "Assistant" : "User";
    const text = (turn.parts || [])
      .map((part: any) => part.text || "")
      .filter(Boolean)
      .join("\n");
    return text ? `${role}: ${text}` : "";
  }).filter(Boolean);

  if (turns.length === 1 && turns[0].startsWith("User: ")) {
    return turns[0].slice("User: ".length);
  }

  return turns.join("\n\n");
}

function appMessagesToInteractionInput(messages: any[]) {
  const turns = (messages || []).map((message) => {
    const sender = String(message.sender || "unknown").trim() || "unknown";
    const replyTo = String(message.replyTo || "").trim();
    const content = String(message.content || "").trim();
    const contextText = serializeMessageContext(message.context);
    const route = replyTo ? `${sender} -> ${replyTo}` : sender;
    const parts = [`From: ${route}`];
    if (contextText) parts.push(contextText);
    if (content) parts.push(content);
    return parts.join("\n\n");
  }).filter(Boolean);

  return turns.length === 1 ? turns[0] : turns.join("\n\n---\n\n");
}

function serializeMessageContext(context: any = {}) {
  const parts = [];
  const toolHints = Array.isArray(context.toolHints)
    ? context.toolHints.map((hint: any) => String(hint || "").trim()).filter(Boolean)
    : [];
  if (toolHints.length > 0) {
    parts.push(`<tool_suggestion>${toolHints.join(", ")}</tool_suggestion>`);
  }

  const attachments = Array.isArray(context.attachments) ? context.attachments : [];
  if (attachments.length > 0) {
    const attachmentText = attachments.map((attachment: any) => {
      const title = attachment.title || attachment.kind || "Context";
      const payload = typeof attachment.payload === "string"
        ? attachment.payload
        : JSON.stringify(attachment.payload || attachment, null, 2);
      return `Attachment "${title}":\n${payload}`;
    });
    parts.push(`<context>\n${attachmentText.join("\n\n---\n\n")}\n</context>`);
  }

  if (context.workspaceStatus) {
    parts.push(`<workspace_status>\n${JSON.stringify(context.workspaceStatus, null, 2)}\n</workspace_status>`);
  }

  return parts.join("\n\n");
}

function normalizeAppMessages(messages: any) {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((message) => ({
      sender: String(message?.sender || "").trim(),
      content: String(message?.content || ""),
      replyTo: message?.replyTo ? String(message.replyTo).trim() : "",
      context: message?.context && typeof message.context === "object" ? message.context : {}
    }))
    .filter((message) =>
      message.sender
      && (message.content.trim()
        || (Array.isArray(message.context.attachments) && message.context.attachments.length > 0)
        || (Array.isArray(message.context.toolHints) && message.context.toolHints.length > 0)
        || Boolean(message.context.workspaceStatus))
    );
}

function getInteractionOutputText(interaction: any) {
  if (typeof interaction.output_text === "string") return interaction.output_text;
  if (Array.isArray(interaction.outputs)) {
    const lastText = interaction.outputs
      .filter((output: any) => output.type === "text" && output.text)
      .at(-1);
    if (lastText) return lastText.text;
  }

  const modelOutputs = (interaction.steps || []).filter((step: any) => step.type === "model_output");
  const lastOutput = modelOutputs.at(-1);
  return (lastOutput?.content || [])
    .filter((content: any) => content.type === "text" && content.text)
    .map((content: any) => content.text)
    .join("");
}

function getInteractionFunctionCalls(interaction: any) {
  const stepCalls = (interaction.steps || [])
    .filter((step: any) => step.type === "function_call")
    .map((step: any) => ({
      id: step.id,
      name: step.name,
      args: step.arguments || {}
    }));
  if (stepCalls.length > 0) return stepCalls;

  return (interaction.outputs || [])
    .filter((output: any) => output.type === "function_call")
    .map((output: any) => ({
      id: output.call_id || output.id,
      name: output.name,
      args: output.arguments || {}
    }));
}

function toInteractionTools(functionDeclarations: any[]) {
  return functionDeclarations.map((declaration) => ({
    type: "function",
    name: declaration.name,
    description: declaration.description,
    parameters: normalizeJsonSchema(getToolParametersSchema(declaration))
  }));
}

function getToolParametersSchema(declaration: any) {
  if (declaration.parameters) {
    return declaration.parameters;
  }

  const params = Array.isArray(declaration.params) ? declaration.params : [];
  return {
    type: "OBJECT",
    properties: Object.fromEntries(params.map((param: any) => [
      param.name,
      { type: param.type || "string" }
    ])),
    required: params.filter((param: any) => param.required !== false).map((param: any) => param.name),
    additionalProperties: false
  };
}

function normalizeJsonSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeJsonSchema);

  const normalized: any = {};
  Object.entries(schema).forEach(([key, value]) => {
    normalized[key] = key === "type" && typeof value === "string"
      ? value.toLowerCase()
      : normalizeJsonSchema(value);
  });
  return normalized;
}

async function queryConfiguredSource(sources: any[], sourceId: string, params = {}) {
  const source = findConfiguredSource(sources, sourceId);
  if (!source) {
    throw new Error(`Source not found: ${sourceId}`);
  }

  const baseUrl = getSourceQueryBaseUrl(source);
  if (!isHttpUrl(baseUrl)) {
    throw new Error(`Source ${source.name || source.id} does not have a valid query URL.`);
  }

  const mergedParams = {
    ...sourceParamsToObject(source.defaultParams || [], { omitTemplates: true }),
    ...sanitizeQueryParams(params)
  };
  const url = buildUrlWithParams(baseUrl, mergedParams);
  const result = await fetchQueryPayload(url);

  return {
    source: {
      id: source.id,
      name: source.name,
      type: source.type,
      description: source.description || ""
    },
    request: result.request,
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    contentType: result.contentType,
    durationMs: result.durationMs,
    timestamp: result.timestamp,
    response: result.response,
    responsePreview: result.responsePreview,
    parseError: result.parseError
  };
}

function createSourceQueryRecord(result: any) {
  const sourceName = result.source?.name || result.source?.id || "Dataset";
  return {
    kind: sourceName,
    title: `${sourceName} agent query`,
    request: result.request,
    response: result.response,
    durationMs: result.durationMs,
    timestamp: result.timestamp,
    payload: {
      source: result.source,
      request: result.request,
      ok: result.ok,
      status: result.status,
      statusText: result.statusText,
      contentType: result.contentType,
      durationMs: result.durationMs,
      timestamp: result.timestamp,
      response: result.response,
      responsePreview: result.responsePreview,
      parseError: result.parseError,
      outputVariables: {}
    }
  };
}

function findConfiguredSource(sources: any[], sourceId: string) {
  const target = String(sourceId || "").trim().toLowerCase();
  if (!target) return null;
  return (sources || [])
    .filter((source) => !source.isDeleted)
    .find((source) =>
      String(source.id || "").toLowerCase() === target
      || String(source.name || "").toLowerCase() === target
    ) || null;
}

function getSourceQueryBaseUrl(source: any) {
  if (source.queryUrl) return source.queryUrl;

  const overviewUrl = String(source.overviewUrl || "").replace(/\/$/, "");
  if (!overviewUrl) return "";
  if (isSocrataSourceUrl(overviewUrl) || source.type === "socrata-dataset") {
    return normalizeSocrataResourceUrl(overviewUrl) || overviewUrl;
  }
  return `${overviewUrl}/query`;
}

function sourceParamsToObject(rows: any[], options: any = {}) {
  const params: any = {};
  (rows || []).forEach((row) => {
    const key = String(row.key || "").trim();
    const value = row.value;
    if (!key) return;
    if (options.omitTemplates && hasUnresolvedTemplate(value)) return;
    params[key] = value;
  });
  return params;
}

function sanitizeQueryParams(params: any) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};

  return Object.fromEntries(
    Object.entries(params)
      .filter(([key, value]) => key && value !== undefined && value !== null)
      .map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)])
  );
}

function hasUnresolvedTemplate(value: any) {
  return /\{\{\s*[^}]+\s*\}\}/.test(String(value ?? ""));
}

function buildUrlWithParams(baseUrl: string, params: any) {
  const url = new URL(baseUrl);
  Object.entries(params || {}).forEach(([key, value]: any) => {
    if (key) url.searchParams.set(key, value);
  });
  return url.toString();
}

function isSocrataSourceUrl(url: string) {
  try {
    const { hostname, pathname } = new URL(url);
    return hostname.includes("socrata.com")
      || hostname.includes("opendata")
      || /\/resource\/[a-z0-9]{4}-[a-z0-9]{4}/i.test(pathname)
      || /\/api\/views\/[a-z0-9]{4}-[a-z0-9]{4}/i.test(pathname);
  } catch {
    return false;
  }
}

function normalizeSocrataResourceUrl(url: string) {
  const parts = getSocrataUrlParts(url);
  return parts ? `${parts.origin}/resource/${parts.id}.json` : "";
}

function getSocrataUrlParts(url: string) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/([a-z0-9]{4}-[a-z0-9]{4})(?:\.json)?/i);
    if (!match) return null;
    return { origin: parsed.origin, id: match[1].toLowerCase() };
  } catch {
    return null;
  }
}

async function fetchQueryPayload(queryUrl: string) {
  const startedAt = performance.now();
  const upstreamResponse = await fetch(queryUrl, {
    headers: {
      Accept: "application/json, application/geo+json, text/html;q=0.8, */*;q=0.5",
      "User-Agent": "research-agent/1.0"
    }
  });
  const durationMs = Math.round(performance.now() - startedAt);
  const contentType = upstreamResponse.headers.get("content-type") || "";
  const responseText = await upstreamResponse.text();
  const payload: any = {
    ok: upstreamResponse.ok,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    contentType,
    durationMs,
    timestamp: new Date().toISOString(),
    request: {
      method: "GET",
      url: queryUrl
    }
  };

  if (isJsonContentType(contentType)) {
    try {
      payload.response = JSON.parse(responseText);
    } catch (error) {
      payload.ok = false;
      payload.parseError = errorMessage(error);
      payload.responsePreview = responseText.slice(0, 500);
    }
  } else if (contentType.includes("text/html")) {
    payload.responseType = "html";
    payload.responseText = responseText;
    payload.responsePreview = responseText.slice(0, 500);
  } else {
    payload.responsePreview = responseText.slice(0, 500);
  }

  return payload;
}
