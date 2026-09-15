"use client";

import { useEffect, useRef, useState } from "react";
import { markdownToHtml } from "@/lib/markdown";
import type { FeatureName } from "@/lib/features";
import type { WorkspaceInvalidationScope } from "@/lib/workspaceInvalidation";
import { chatWithAgent, getAgentSessions, saveAgentRegistry } from "@/features/agent/agent.api";
import styles from "./AgentArea.module.css";

type AgentMessage = {
  id: string;
  sender: "user" | "assistant" | "system" | "error";
  content: string;
  html?: string;
};

type AgentRuntimeBridge = {
  catalogContextProvider: (() => unknown) | null;
  catalogEventHandler: ((event: unknown, bubble: HTMLElement, thread: HTMLElement) => void) | null;
  recordController: { add?: (record: unknown) => void } | null;
};

type AgentSession = {
  id: string;
  title: string;
  history: AgentMessage[];
};

type AgentRegistry = {
  activeSessionId: string;
  sessions: AgentSession[];
};

type AgentAreaProps = {
  onInvalidateWorkspaceData?: (featureId: FeatureName, scopes: WorkspaceInvalidationScope | WorkspaceInvalidationScope[]) => void;
  selectedSession?: { id: string } | null;
};

const agentRuntimeBridge: AgentRuntimeBridge = {
  catalogContextProvider: null,
  catalogEventHandler: null,
  recordController: null
};

export const AgentArea = ({ onInvalidateWorkspaceData, selectedSession = null }: AgentAreaProps) => {
  const threadRef = useRef<HTMLDivElement | null>(null);
  const assistantBubbleRef = useRef<HTMLDivElement | null>(null);
  const [registry, setRegistry] = useState<AgentRegistry>({ activeSessionId: "", sessions: [] });
  const [currentSessionId, setCurrentSessionId] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [unsavedSession, setUnsavedSession] = useState<AgentSession | null>(null);

  useEffect(() => {
    void loadRegistry();
  }, []);

  useEffect(() => {
    if (!selectedSession?.id) return;
    const session = registry.sessions.find((item) => item.id === selectedSession.id);
    if (!session) return;
    setCurrentSessionId(session.id);
    setMessages(hydrateMessages(session.history));
    setUnsavedSession(null);
  }, [registry.sessions, selectedSession]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages]);

  const loadRegistry = async () => {
    const response = await getAgentSessions();
    if (!response.ok) return;
    const nextRegistry = normalizeRegistry(await response.json());
    setRegistry(nextRegistry);
    const activeSession = nextRegistry.sessions.find((session) => session.id === nextRegistry.activeSessionId) || nextRegistry.sessions[0] || null;
    if (!activeSession) return;
    setCurrentSessionId(activeSession.id);
    setMessages(hydrateMessages(activeSession.history));
  };

  const updateMessage = (messageId: string, patch: Partial<AgentMessage>) => {
    setMessages((current) => current.map((message) => message.id === messageId ? { ...message, ...patch } : message));
  };

  const streamAssistantResponse = async (responseBody: ReadableStream<Uint8Array> | null, messageId: string) => {
    if (!responseBody) return "";

    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let fullText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          const chunk = parseStreamChunk(data);
          if (!chunk) continue;

          if (chunk.type === "record") {
            agentRuntimeBridge.recordController?.add?.(chunk.record);
            continue;
          }

          if (chunk.type === "error") {
            const detail = chunk.detail ? ` ${chunk.detail}` : "";
            updateMessage(messageId, { sender: "error", content: `${chunk.message || "Request failed"}${detail}`, html: "" });
            return "";
          }

          const delta = chunk.type === "text"
            ? chunk.delta || ""
            : chunk.candidates?.[0]?.content?.parts?.[0]?.text || "";

          if (delta) {
            fullText += delta;
            updateMessage(messageId, { content: fullText, html: markdownToHtml(fullText) });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return fullText;
  };

  const handleSubmit = async () => {
    const text = inputValue.trim();
    if (!text || busy) return;

    const apiKey = getDefaultAgentApiKey();
    if (!apiKey) {
      setMessages((current) => [...current, createMessage({ sender: "error", content: "Agent API key is missing from local settings." })]);
      return;
    }

    const userMessage = createMessage({ sender: "user", content: text });
    const assistantMessage = createMessage({ sender: "assistant", content: "Thinking..." });
    const requestMessages = [...messages, userMessage]
      .filter((message) => message.sender !== "error")
      .map((message) => ({
        sender: message.sender,
        content: message.content,
        context: {}
      }));

    setInputValue("");
    setBusy(true);
    const firstMessages = [...messages, userMessage, assistantMessage];
    setMessages(firstMessages);

    const session = getCurrentSession(registry, currentSessionId, unsavedSession) || createSessionFromMessage(userMessage);
    const isNewSession = !registry.sessions.some((item) => item.id === session.id);
    const userPersistedMessages = [...messages, userMessage];
    const userRegistry = upsertSession(registry, {
      ...session,
      title: getSessionTitle(session, userMessage),
      history: userPersistedMessages
    });
    setRegistry(userRegistry);
    setCurrentSessionId(session.id);
    setUnsavedSession(null);
    await persistRegistry(userRegistry);
    onInvalidateWorkspaceData?.("agent", isNewSession ? ["info", "detail"] : "detail");

    try {
      const response = await chatWithAgent({ apiKey, messages: requestMessages });
      if (!response.ok) {
        const error = await readErrorResponse(response);
        updateMessage(assistantMessage.id, { sender: "error", content: error.error || "Request failed.", html: "" });
        return;
      }

      const responseText = await streamAssistantResponse(response.body, assistantMessage.id);
      if (!responseText) {
        updateMessage(assistantMessage.id, { sender: "error", content: "Empty response from model.", html: "" });
        await persistSessionMessages(userRegistry, session.id, [...userPersistedMessages, { ...assistantMessage, sender: "error", content: "Empty response from model.", html: "" }]);
      } else {
        await persistSessionMessages(userRegistry, session.id, [...userPersistedMessages, { ...assistantMessage, content: responseText, html: markdownToHtml(responseText) }]);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Request failed.";
      updateMessage(assistantMessage.id, { sender: "error", content: errorMessage, html: "" });
      await persistSessionMessages(userRegistry, session.id, [...userPersistedMessages, { ...assistantMessage, sender: "error", content: errorMessage, html: "" }]);
    } finally {
      setBusy(false);
    }
  };

  const persistSessionMessages = async (baseRegistry: AgentRegistry, sessionId: string, nextMessages: AgentMessage[]) => {
    const session = getCurrentSession(baseRegistry, sessionId, unsavedSession);
    if (!session) return;
    const nextRegistry = upsertSession(baseRegistry, { ...session, history: nextMessages });
    setRegistry(nextRegistry);
    await persistRegistry(nextRegistry);
    onInvalidateWorkspaceData?.("agent", "detail");
  };

  const startNewSession = () => {
    const session = createEmptySession();
    setUnsavedSession(session);
    setCurrentSessionId(session.id);
    setMessages([]);
    setInputValue("");
  };

  return (
    <aside className={styles.panel} aria-label="Agent">
      <AgentToolbar startNewSession={startNewSession} />
      <AgentThread
        assistantBubbleRef={assistantBubbleRef}
        messages={messages}
        threadRef={threadRef}
      />
      <AgentComposer
        busy={busy}
        inputValue={inputValue}
        setInputValue={setInputValue}
        submit={handleSubmit}
      />
    </aside>
  );
};

const AgentToolbar = ({ startNewSession }: { startNewSession: () => void }) => {
  return (
    <div className={styles.toolbar}>
      <button className={styles.newSessionButton} type="button" onClick={startNewSession}>
        New Chat
      </button>
    </div>
  );
};

const AgentThread = ({ assistantBubbleRef, messages, threadRef }: { assistantBubbleRef: React.RefObject<HTMLDivElement | null>; messages: AgentMessage[]; threadRef: React.RefObject<HTMLDivElement | null> }) => {
  return (
    <div className={styles.thread} ref={threadRef}>
      {messages.map((message) => (
        <AgentMessageBubble
          bubbleRef={message.sender === "assistant" ? assistantBubbleRef : undefined}
          key={message.id}
          message={message}
        />
      ))}
    </div>
  );
};

const AgentMessageBubble = ({ bubbleRef, message }: { bubbleRef?: React.RefObject<HTMLDivElement | null>; message: AgentMessage }) => {
  const className = [
    styles.message,
    message.sender === "user" ? styles.userMessage : "",
    message.sender === "assistant" ? styles.assistantMessage : "",
    message.sender === "system" ? styles.systemMessage : "",
    message.sender === "error" ? styles.errorMessage : ""
  ].filter(Boolean).join(" ");

  return (
    <div ref={bubbleRef} className={className}>
      {message.html ? (
        <div className={styles.messageText} dangerouslySetInnerHTML={{ __html: message.html }} />
      ) : (
        <p className={styles.messageText}>{message.content}</p>
      )}
    </div>
  );
};

const AgentComposer = ({ busy, inputValue, setInputValue, submit }: { busy: boolean; inputValue: string; setInputValue: (value: string) => void; submit: () => void }) => {
  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        className={styles.input}
        rows={4}
        placeholder="Message"
        value={inputValue}
        disabled={busy}
        onChange={(event) => setInputValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
      />
      <button className={styles.send} type="submit" disabled={busy}>
        {busy ? "Sending" : "Send"}
      </button>
    </form>
  );
};

export function createAgentController() {
  return {
    addMessage: () => {},
    attachRecord: () => {},
    suggestTool: () => {},
    focusComposer: () => {},
    setCatalogContextProvider: (provider: (() => unknown) | null) => {
      agentRuntimeBridge.catalogContextProvider = typeof provider === "function" ? provider : null;
    },
    setCatalogEventHandler: (handler: AgentRuntimeBridge["catalogEventHandler"]) => {
      agentRuntimeBridge.catalogEventHandler = typeof handler === "function" ? handler : null;
    },
    setRecordController: (controller: AgentRuntimeBridge["recordController"]) => {
      agentRuntimeBridge.recordController = controller || null;
    },
    setAttachmentTargetProvider: () => {},
    setPageStatusProvider: () => {},
    refreshAgentTargets: () => {}
  };
}

function createMessage({ sender, content }: Pick<AgentMessage, "sender" | "content">): AgentMessage {
  return {
    id: globalThis.crypto?.randomUUID?.() || `agent-message-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    sender,
    content,
    html: sender === "assistant" ? markdownToHtml(content) : undefined
  };
}

function createEmptySession(): AgentSession {
  return {
    id: createId(),
    title: "New Chat",
    history: []
  };
}

function createSessionFromMessage(message: AgentMessage): AgentSession {
  return {
    id: createId(),
    title: getTitleFromMessage(message),
    history: [message]
  };
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getCurrentSession(registry: AgentRegistry, sessionId: string, unsavedSession: AgentSession | null) {
  if (unsavedSession?.id === sessionId) return unsavedSession;
  return registry.sessions.find((session) => session.id === sessionId) || null;
}

function getSessionTitle(session: AgentSession, message: AgentMessage) {
  return session.title && session.title !== "New Chat" ? session.title : getTitleFromMessage(message);
}

function getTitleFromMessage(message: AgentMessage) {
  const title = message.content.trim().replace(/\s+/g, " ").slice(0, 48);
  return title || "New Chat";
}

function hydrateMessages(messages: unknown): AgentMessage[] {
  return Array.isArray(messages)
    ? messages.map((message: any) => ({
      id: typeof message?.id === "string" ? message.id : createId(),
      sender: isAgentMessageSender(message?.sender) ? message.sender : "assistant",
      content: String(message?.content || ""),
      html: typeof message?.html === "string" ? message.html : message?.sender === "assistant" ? markdownToHtml(String(message?.content || "")) : undefined
    }))
    : [];
}

function isAgentMessageSender(sender: unknown): sender is AgentMessage["sender"] {
  return sender === "user" || sender === "assistant" || sender === "system" || sender === "error";
}

function normalizeRegistry(value: any): AgentRegistry {
  const sessions = Array.isArray(value?.sessions)
    ? value.sessions.map((session: any) => ({
      id: typeof session?.id === "string" ? session.id : createId(),
      title: String(session?.title || session?.name || "Untitled Chat"),
      history: hydrateMessages(session?.history)
    }))
    : [];

  return {
    activeSessionId: typeof value?.activeSessionId === "string" ? value.activeSessionId : sessions[0]?.id || "",
    sessions
  };
}

function upsertSession(registry: AgentRegistry, session: AgentSession): AgentRegistry {
  const exists = registry.sessions.some((item) => item.id === session.id);
  return {
    activeSessionId: session.id,
    sessions: exists
      ? registry.sessions.map((item) => item.id === session.id ? session : item)
      : [session, ...registry.sessions]
  };
}

async function persistRegistry(registry: AgentRegistry) {
  const response = await saveAgentRegistry(registry);
  if (!response.ok) {
    const error = await readErrorResponse(response);
    throw new Error(error.error || "Agent session save failed.");
  }
}

function parseStreamChunk(data: string) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function readErrorResponse(response: Response) {
  const fallback = `HTTP ${response.status}`;
  const text = await response.text().catch(() => "");
  if (!text) return { error: fallback };
  try {
    const parsed = JSON.parse(text);
    return { error: parsed.error || parsed.message || fallback };
  } catch {
    const cleaned = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return { error: cleaned ? `${fallback}: ${cleaned.slice(0, 300)}` : fallback };
  }
}

function getDefaultAgentApiKey() {
  return getWorkspaceSettingValue(["GEMINI_API_KEY", "GOOGLE_API_KEY"])
    || localStorage.getItem("research-agent.geminiApiKey")
    || localStorage.getItem("research-agent.agentApiKey")
    || "";
}

function getWorkspaceSettingValue(keys: string[]) {
  try {
    const settings = JSON.parse(localStorage.getItem("research-agent.settings") || "[]");
    if (!Array.isArray(settings)) return "";
    for (const key of keys) {
      const setting = settings.find((item) => item?.key === key);
      if (typeof setting?.value === "string" && setting.value.trim()) return setting.value.trim();
    }
  } catch {}
  return "";
}
