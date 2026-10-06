// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type HookQuestionItem } from "../core/state";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Clears an interactive request before its hook relay times out. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  coucou_kind?: string;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

function liveFileEdits(tool: string, input: Record<string, unknown>): Array<{
  path: string;
  oldText: string;
  newText: string;
}> {
  const path = typeof input.file_path === "string" ? input.file_path : "";
  if (!path) return [];
  if (tool === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    return [{ path, oldText: input.old_string, newText: input.new_string }];
  }
  if (tool === "Write" && typeof input.content === "string") {
    return [{ path, oldText: "", newText: input.content }];
  }
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const edit = raw as Record<string, unknown>;
      if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") return [];
      return [{ path, oldText: edit.old_string, newText: edit.new_string }];
    }).slice(0, 10);
  }
  return [];
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function parseQuestionItems(toolInput: Record<string, unknown> | undefined): HookQuestionItem[] | null {
  const rawQuestions = toolInput?.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4) return null;
  const questions: HookQuestionItem[] = [];
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const question = raw as Record<string, unknown>;
    if (typeof question.question !== "string" || !question.question.trim() || question.question.length > 2000) return null;
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) return null;
    const options = [];
    for (const rawOption of question.options) {
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return null;
      const option = rawOption as Record<string, unknown>;
      if (typeof option.label !== "string" || !option.label.trim() || option.label.length > 250) return null;
      if (option.description !== undefined && (typeof option.description !== "string" || option.description.length > 1000)) return null;
      options.push({
        label: option.label,
        description: typeof option.description === "string" ? option.description : "",
      });
    }
    questions.push({
      question: question.question,
      header: typeof question.header === "string" ? question.header.slice(0, 12) : "",
      options,
      multiSelect: question.multiSelect === true,
    });
  }
  return questions;
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "VS Code";
  t.pillBadge = null;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code pill unchanged.
  const validAgent = validateAgent(payload.coucou_agent);
  const agentId = validAgent ? `agent_${validAgent}` : CLAUDE_ID;
  const isExternalAgent = validAgent !== null;

  const focused = State.focusId === agentId;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** Ensure the agent pill exists (no-op for Claude Code). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, validAgent!, agentColor(validAgent!));
    } else {
      upsert(projectName, cwd);
    }
  };

  switch (name) {
    case "SessionStart":
      ensurePill();
      State.clearCodeSession(agentId);
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      State.startCodeActivity(agentId, projectName, "Prompt", asked?.slice(0, 100) ?? "New coding request");
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      if (payload.coucou_kind === "ask_user_question") {
        const requestId = payload.request_id ?? "";
        const questions = parseQuestionItems(payload.tool_input);
        if (isExternalAgent || !requestId || !questions) {
          if (requestId) void Bridge.approvalDecline(requestId);
          break;
        }
        const existing = State.pendingApproval ?? State.pendingQuestion;
        if (existing && existing.requestId !== requestId) {
          void Bridge.approvalDecline(requestId);
          break;
        }
        upsert(projectName, cwd);
        if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
        State.pendingQuestion = {
          requestId,
          sessionId: payload.session_id ?? "",
          questions,
        };
        if (requestId) void Bridge.approvalAck(requestId);
        State.updateTask(CLAUDE_ID, "question");
        State.isPinned = true;
        State.setPillBadge(CLAUDE_ID, null);
        Sound.play("question");
        island.alert("tools");
        pendingTimeout = window.setTimeout(() => {
          pendingTimeout = null;
          if (State.pendingQuestion?.requestId !== requestId) return;
          State.pendingQuestion = null;
          State.isPinned = false;
          island.dropPin();
          State.updateTask(CLAUDE_ID, "working");
          State.setPillBadge(CLAUDE_ID, null);
          if (State.view === "question") island.setView(State.defaultView());
          State.notify();
        }, 106_000);
        break;
      }
      ensurePill();
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.appendStep(agentId, stepLabel(tool, input));
      State.startCodeActivity(agentId, projectName, tool, stepLabel(tool, input));
      surface("overview", false);
      break;
    }

    case "PostToolUse": {
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.finishCodeActivity(agentId, tool);
      for (const edit of liveFileEdits(tool, payload.tool_input ?? {})) {
        if (edit.oldText.length + edit.newText.length > 24_000) continue;
        State.addLiveCodeChange(agentId, projectName, edit.path, edit.oldText, edit.newText);
      }
      break;
    }

    case "PostToolUseFailure":
      State.updateTask(agentId, "working");
      State.finishCodeActivity(agentId, payload.tool_name ?? "Tool", true);
      State.appendStep(agentId, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop":
      State.updateTask(agentId, "finished");
      if (payload.message) State.appendStep(agentId, payload.message.slice(0, 60));
      State.finishCodeActivities(agentId);
      State.startCodeActivity(agentId, projectName, "Done", payload.message?.slice(0, 120) ?? "Coding session finished");
      State.finishCodeActivity(agentId, "Done");
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(agentId, "finished");
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else {
          State.updateTask(agentId, "idle");
          State.setPillBadge(agentId, null);
        }
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(agentId, "error");
      State.finishCodeActivities(agentId, true);
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
      State.finishCodeActivities(agentId);
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else {
        State.updateTask(agentId, "idle");
        clearSession();
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(agentId, "• subagent done");
      break;

    case "PermissionRequest": {
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (isExternalAgent) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      const existing = State.pendingApproval ?? State.pendingQuestion;
      if (existing && existing.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      upsert(projectName, cwd);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
      };
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(CLAUDE_ID, "approval");
      State.isPinned = true;
      Sound.play("approval");
      State.setPillBadge(CLAUDE_ID, "approval");
      island.alert("tools");
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (State.pendingApproval?.requestId !== requestId) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(CLAUDE_ID, "working");
        State.setPillBadge(CLAUDE_ID, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 106_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
