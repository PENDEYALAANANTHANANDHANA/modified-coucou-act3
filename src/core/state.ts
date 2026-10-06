// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
}

export interface HookQuestionOption {
  label: string;
  description: string;
}

export interface HookQuestionItem {
  question: string;
  header: string;
  options: HookQuestionOption[];
  multiSelect: boolean;
}

export interface PendingQuestion {
  requestId: string;
  sessionId: string;
  questions: HookQuestionItem[];
}

export interface PendingMcpApproval {
  requestId: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  arguments: unknown;
}

export interface CodeActivityEntry {
  id: number;
  agentId: string;
  agentName: string;
  tool: string;
  detail: string;
  status: "running" | "done" | "failed";
  at: number;
}

export interface LiveCodeChange {
  id: number;
  agentId: string;
  agentName: string;
  path: string;
  oldText: string;
  newText: string;
  at: number;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type ChatAgentId = "omniroute" | "openrouter" | "ollama";

export const CHAT_AGENTS: Record<ChatAgentId, {
  name: string;
  purpose: string;
  color: string;
  modelSetting: "omnirouteModel" | "openrouterModel" | "ollamaModel";
}> = {
  omniroute: {
    name: "OmniRoute",
    purpose: "Online model router",
    color: "#a855f7",
    modelSetting: "omnirouteModel",
  },
  openrouter: {
    name: "OpenRouter",
    purpose: "Cloud model catalog",
    color: "#38bdf8",
    modelSetting: "openrouterModel",
  },
  ollama: {
    name: "Ollama",
    purpose: "Local model chat",
    color: "#a3e635",
    modelSetting: "ollamaModel",
  },
};

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  friendModeEnabled: boolean;
  friendModeMinMinutes: number;
  friendModeMaxMinutes: number;
  friendModeQuietStartHour: number;
  friendModeQuietEndHour: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Selected model used by the active provider. */
  model: string;
  omnirouteModel: string;
  openrouterModel: string;
  ollamaModel: string;
  provider: "online" | "openrouter" | "omniroute" | "ollama";
  onlineBaseUrl: string;
  openrouterBaseUrl: string;
  omnirouteBaseUrl: string;
  ollamaUrl: string;
  mcpServers: McpServerConfig[];
}

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  friendModeEnabled: false,
  friendModeMinMinutes: 30,
  friendModeMaxMinutes: 90,
  friendModeQuietStartHour: 22,
  friendModeQuietEndHour: 8,
  activeIntegrations: [
    "integration_resend", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "openrouter/auto",
  omnirouteModel: "openrouter/auto",
  openrouterModel: "openrouter/auto",
  ollamaModel: "llama3.2",
  provider: "openrouter",
  onlineBaseUrl: "https://api.openai.com/v1",
  openrouterBaseUrl: "https://openrouter.ai/api/v1",
  omnirouteBaseUrl: "http://localhost:20128/v1",
  ollamaUrl: "http://127.0.0.1:11434",
  mcpServers: [],
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  projectRootContext: string | null = null;
  previousWindowContext: { appName: string; title: string; windowId: number } | null = null;
  attachedWindowContext: { appName: string; title: string; windowId: number } | null = null;
  attachedWindowCapture: import("./bridge").WindowCapture | null = null;
  droppedFile: { name: string; path: string } | null = null;
  droppedFiles: { name: string; path: string }[] = [];
  activeDocument: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatAgent: ChatAgentId = "openrouter";
  readonly chatHistories: Record<ChatAgentId, ChatMessage[]> = {
    omniroute: [],
    openrouter: [],
    ollama: [],
  };
  promptPrefill = "";
  pendingApproval: ApprovalInfo | null = null;
  pendingQuestion: PendingQuestion | null = null;
  readonly pendingMcpApprovals: PendingMcpApproval[] = [];
  readonly codeActivity: CodeActivityEntry[] = [];
  readonly liveCodeChanges: LiveCodeChange[] = [];
  private nextCodeActivityId = 1;
  private nextLiveCodeChangeId = 1;
  pendingDesktopAction: {
    windowId: number;
    appName: string;
    title: string;
    width: number;
    height: number;
    summary: string;
    action: import("./bridge").WindowAction;
  } | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  get chatHistory(): ChatMessage[] {
    return this.chatHistories[this.chatAgent];
  }

  set chatHistory(messages: ChatMessage[]) {
    this.chatHistories[this.chatAgent] = messages;
  }

  setChatAgent(agent: ChatAgentId) {
    if (this.chatAgent === agent) return;
    this.chatAgent = agent;
    this.notify();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  startCodeActivity(agentId: string, agentName: string, tool: string, detail: string) {
    const entry: CodeActivityEntry = {
      id: this.nextCodeActivityId++,
      agentId,
      agentName,
      tool,
      detail,
      status: "running",
      at: Date.now(),
    };
    this.codeActivity.push(entry);
    if (this.codeActivity.length > 40) this.codeActivity.splice(0, this.codeActivity.length - 40);
    this.notify();
  }

  finishCodeActivity(agentId: string, tool: string, failed = false, detail?: string) {
    const entry = [...this.codeActivity].reverse().find(
      (item) => item.agentId === agentId && item.tool === tool && item.status === "running",
    );
    if (!entry) return;
    entry.status = failed ? "failed" : "done";
    if (detail) entry.detail = detail;
    this.notify();
  }

  finishCodeActivities(agentId: string, failed = false) {
    let changed = false;
    for (const entry of this.codeActivity) {
      if (entry.agentId === agentId && entry.status === "running") {
        entry.status = failed ? "failed" : "done";
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  clearCodeSession(agentId: string) {
    const previousActivityCount = this.codeActivity.length;
    const previousChangeCount = this.liveCodeChanges.length;
    this.codeActivity.splice(0, this.codeActivity.length, ...this.codeActivity.filter((entry) => entry.agentId !== agentId));
    this.liveCodeChanges.splice(0, this.liveCodeChanges.length, ...this.liveCodeChanges.filter((change) => change.agentId !== agentId));
    if (previousActivityCount !== this.codeActivity.length || previousChangeCount !== this.liveCodeChanges.length) {
      this.notify();
    }
  }

  addLiveCodeChange(agentId: string, agentName: string, path: string, oldText: string, newText: string) {
    const change: LiveCodeChange = {
      id: this.nextLiveCodeChangeId++,
      agentId,
      agentName,
      path,
      oldText,
      newText,
      at: Date.now(),
    };
    this.liveCodeChanges.push(change);
    if (this.liveCodeChanges.length > 20) this.liveCodeChanges.splice(0, this.liveCodeChanges.length - 20);
    this.notify();
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude first, then agent_* pills (visible in slice(0,4)),
    // then other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const isAgentA = a.id.startsWith("agent_");
      const isAgentB = b.id.startsWith("agent_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
