// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { open } from "@tauri-apps/plugin-dialog";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask, type LiveCodeChange, type PendingMcpApproval, type PendingQuestion } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { Bridge, type CodeProposal, type McpTool, type WindowAction } from "../core/bridge";
import { Sound } from "../core/sound";
import { executeTask, parseTask, TASK_HELP } from "../tools/task-runner";

type ProjectEditor = "vscode" | "cursor" | "system";

function selectedProjectEditor(select: HTMLSelectElement): ProjectEditor {
  if (select.value === "vscode" || select.value === "cursor") return select.value;
  return "system";
}

function liveDiff(change: LiveCodeChange): HTMLElement {
  const maxChars = 20_000;
  const maxLines = 120;
  const oldText = change.oldText.slice(0, maxChars);
  const newText = change.newText.slice(0, maxChars);
  const oldLines = oldText.split(/\r?\n/).slice(0, maxLines);
  const newLines = newText.split(/\r?\n/).slice(0, maxLines);
  const truncated = oldText.length < change.oldText.length || newText.length < change.newText.length
    || oldText.split(/\r?\n/).length > maxLines || newText.split(/\r?\n/).length > maxLines;
  const table = Array.from({ length: oldLines.length + 1 }, () => new Uint16Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      table[i][j] = oldLines[i] === newLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result: { kind: "same" | "removed" | "added"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      result.push({ kind: "same", text: oldLines[i++] });
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push({ kind: "removed", text: oldLines[i++] });
    } else {
      result.push({ kind: "added", text: newLines[j++] });
    }
  }
  while (i < oldLines.length) result.push({ kind: "removed", text: oldLines[i++] });
  while (j < newLines.length) result.push({ kind: "added", text: newLines[j++] });
  const diff = h("div", { class: "live-diff" });
  if (truncated) {
    diff.append(h("div", {
      class: "live-diff-truncated",
      text: `Showing a bounded preview of the edit (maximum ${maxLines} lines per side).`,
    }));
  }
  result.forEach((line) => {
    diff.append(h("div", { class: `live-diff-line ${line.kind}` },
      h("span", { class: "live-diff-gutter", "aria-hidden": "true", text: line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " " }),
      h("code", { text: line.text || " " }),
    ));
  });
  return diff;
}

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  answerQuestion(answers: Record<string, string | string[]>): Promise<void>;
  declineQuestion(): Promise<void>;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  showCodeReview?(content: HTMLElement, onDismiss: () => void): void;
  dismissCodeReview?(): void;
  attachAskPanels?(
    panels: { id: string; label: string; element: HTMLElement }[],
    sync: () => void,
    tick: (nowMs: number) => void,
  ): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    {
      class: `btn ${kind}`,
      onclick: () => {
        Sound.play("pop");
        onClick();
      },
    },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));
  const tabTools = h("button", { class: "tab", title: "ACT 3 tools", onclick: () => go("tools") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Open ACT 3 settings", onclick: () => actions.openSettingsWindow() }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    Sound.play("pop");
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop, tabTools),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      tabTools.classList.toggle("on", v === "tools");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      const sessionActive =
        task?.id === "integration_claude" && (task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: task.source === "claudeCode" ? "Claude Code" : "n8n" }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const others = State.otherTasks.slice(0, 4);
      const pillKey = others.map((t) => `${t.id}:${t.pillBadge ?? ""}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
        pruneMiniBots();
      }
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask ACT 3", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code is asking a question"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Claude needs an answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — ACT 3 can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

function buildTools(actions: ViewActions, askView: ViewHost): ViewHost {
  const requestSection = h("div", { class: "tool-section hook-request", hidden: true });
  const requestBody = h("div", { class: "hook-request-body" });
  const requestStatus = h("div", { class: "tool-muted hook-request-status" });
  let renderedRequest = "";
  const mcpApprovalSection = h("div", { class: "tool-section hook-request mcp-approval-queue", hidden: true });
  const mcpApprovalStatus = h("div", { class: "tool-muted hook-request-status", "aria-live": "polite" });
  const renderedMcpApprovalIds = { value: "" };

  function renderMcpApprovals() {
    const approvals = State.pendingMcpApprovals;
    mcpApprovalSection.hidden = approvals.length === 0;
    const ids = approvals.map((approval) => approval.requestId).join("|");
    if (ids === renderedMcpApprovalIds.value) return;
    renderedMcpApprovalIds.value = ids;
    clear(mcpApprovalSection);
    mcpApprovalStatus.textContent = "";
    if (approvals.length === 0) return;
    mcpApprovalSection.append(
      h("div", { class: "hook-request-heading", text: "ACT 3 wants permission to use an app tool" }),
      h("div", { class: "tool-muted", text: "Review each request. Allowing runs only this one call." }),
    );
    for (const approval of approvals) {
      mcpApprovalSection.append(renderMcpApproval(approval));
    }
    mcpApprovalSection.append(mcpApprovalStatus);
  }

  function renderMcpApproval(approval: PendingMcpApproval): HTMLElement {
    const itemStatus = h("div", { class: "tool-muted", "aria-live": "polite" });
    const decision = (allow: boolean, buttons: HTMLButtonElement[]) => {
      for (const button of buttons) button.disabled = true;
      itemStatus.textContent = allow ? "Starting the approved tool call…" : "Sending denial…";
      void Bridge.mcpApprovalDecision(approval.requestId, allow).then(
        () => {
          const index = State.pendingMcpApprovals.findIndex((item) => item.requestId === approval.requestId);
          if (index >= 0) State.pendingMcpApprovals.splice(index, 1);
          State.notify();
        },
        (error: unknown) => {
          itemStatus.textContent = `Could not record the decision: ${String(error).replace(/^Error:\s*/, "")}`;
          for (const button of buttons) button.disabled = false;
        },
      );
    };
    const deny = h("button", {
      class: "btn secondary",
      type: "button",
      text: "Deny",
    }) as HTMLButtonElement;
    const allow = h("button", {
      class: "btn primary",
      type: "button",
      text: "Allow once",
    }) as HTMLButtonElement;
    deny.addEventListener("click", () => decision(false, [deny, allow]));
    allow.addEventListener("click", () => decision(true, [deny, allow]));
    return h("div", { class: "mcp-approval-item" },
      h("strong", { class: "tool-title", text: `${approval.serverName} · ${approval.toolName}` }),
      ...(approval.description
        ? [h("div", { class: "tool-muted", text: approval.description })]
        : []),
      h("pre", { class: "mcp-schema", text: JSON.stringify(approval.arguments, null, 2) }),
      h("div", { class: "tool-actions" }, deny, allow),
      itemStatus,
    );
  }

  function renderQuestion(question: PendingQuestion) {
    const selected = question.questions.map((): string[] => []);
    const otherAnswers = question.questions.map(() => "");
    const otherOpen = question.questions.map(() => false);
    const content = h("div", { class: "hook-question-content" });
    let questionIndex = 0;
    const renderCurrent = () => {
      const item = question.questions[questionIndex];
      const choices = selected[questionIndex];
      const hasAnswer = otherOpen[questionIndex]
        ? otherAnswers[questionIndex].trim().length > 0
        : choices.length > 0;
      const optionButtons = item.options.map((option) => h("button", {
        class: `hook-answer-option${choices.includes(option.label) ? " selected" : ""}`,
        type: "button",
        title: option.description,
        text: option.label,
        onclick: () => {
          if (item.multiSelect) {
            const at = choices.indexOf(option.label);
            if (at < 0) choices.push(option.label);
            else choices.splice(at, 1);
          } else {
            choices.splice(0, choices.length, option.label);
          }
          otherOpen[questionIndex] = false;
          renderCurrent();
        },
      }) as HTMLButtonElement);
      const actionRow = h("div", { class: "tool-actions hook-question-actions" });
      const finishOrNext = btn(questionIndex === question.questions.length - 1 ? "Send answer" : "Next", "primary", () => {
        if (questionIndex < question.questions.length - 1) {
          questionIndex++;
          renderCurrent();
          return;
        }
        const answers: Record<string, string | string[]> = {};
        question.questions.forEach((item, index) => {
          const value = otherOpen[index] ? otherAnswers[index].trim() : selected[index];
          answers[item.question] = item.multiSelect
            ? typeof value === "string" ? [value] : value
            : typeof value === "string" ? value : value[0];
        });
        finishOrNext.disabled = true;
        requestStatus.textContent = "Sending your answer…";
        void actions.answerQuestion(answers).then(
          () => { requestStatus.textContent = "Answer sent to Claude Code."; },
          (error: unknown) => {
            requestStatus.textContent = `Could not send the answer: ${String(error).replace(/^Error:\s*/, "")}`;
            finishOrNext.disabled = false;
          },
        );
      }) as HTMLButtonElement;
      finishOrNext.disabled = !hasAnswer;
      actionRow.append(finishOrNext);
      const terminal = btn("Answer in terminal", "secondary", () => {
        requestStatus.textContent = "Returning the question to Claude Code…";
        void actions.declineQuestion().catch((error: unknown) => {
          requestStatus.textContent = `Could not return the question: ${String(error).replace(/^Error:\s*/, "")}`;
        });
      });
      actionRow.append(terminal);

      const questionHeading = h("div", { class: "hook-question-heading" },
        h("span", { class: "tool-label", text: "Claude Code is asking" }),
      );
      if (question.questions.length > 1) {
        questionHeading.append(h("span", {
          class: "tool-muted",
          text: `${questionIndex + 1} / ${question.questions.length}`,
        }));
      }
      clear(content);
      content.append(
        questionHeading,
        ...(item.header ? [h("span", { class: "tool-muted hook-question-category", text: item.header })] : []),
        h("strong", { class: "hook-question-title", text: item.question }),
      );
      if (otherOpen[questionIndex]) {
        const answer = h("input", {
          class: "tool-input hook-answer-text",
          type: "text",
          maxlength: "1000",
          placeholder: "Type your answer…",
          value: otherAnswers[questionIndex],
          oninput: (event: Event) => {
            otherAnswers[questionIndex] = (event.currentTarget as HTMLInputElement).value;
            finishOrNext.disabled = !otherAnswers[questionIndex].trim();
          },
        }) as HTMLInputElement;
        content.append(
          answer,
          h("button", {
            class: "tool-link",
            type: "button",
            text: "Choose from the options",
            onclick: () => { otherOpen[questionIndex] = false; renderCurrent(); },
          }),
        );
        requestAnimationFrame(() => answer.focus());
      } else {
        content.append(
          h("div", { class: "hook-answer-options" }, ...optionButtons),
          h("button", {
            class: "tool-link",
            type: "button",
            text: "Type a different answer…",
            onclick: () => {
              otherOpen[questionIndex] = true;
              selected[questionIndex] = [];
              renderCurrent();
            },
          }),
        );
      }
      content.append(actionRow);
    };
    requestStatus.textContent = "";
    requestBody.append(content);
    renderCurrent();
  }

  function renderPendingRequest() {
    const approval = State.pendingApproval;
    const question = State.pendingQuestion;
    if (!approval && !question) {
      requestSection.hidden = true;
      renderedRequest = "";
      clear(requestBody);
      requestStatus.textContent = "";
      return;
    }
    const key = question ? `question:${question.requestId}` : `approval:${approval!.requestId}`;
    requestSection.hidden = false;
    if (key === renderedRequest) return;
    renderedRequest = key;
    clear(requestBody);
    requestStatus.textContent = "";
    if (question) {
      requestSection.dataset.kind = "question";
      requestSection.append(
        h("div", { class: "hook-request-heading", text: "Claude Code needs your input" }),
        requestBody,
        requestStatus,
      );
      renderQuestion(question);
    } else if (approval) {
      requestSection.dataset.kind = "approval";
      requestBody.append(
        h("div", { class: "hook-request-heading", text: "Permission request" }),
        h("div", { class: "tool-muted", text: `${State.tasks.find((task) => task.id === "integration_claude")?.name ?? "Claude Code"} wants to use ${approval.tool}.` }),
        h("pre", { class: "hook-request-detail", text: approval.command }),
        h("div", { class: "tool-actions" },
          btn("Deny", "secondary", () => actions.decide("deny")),
          btn("Allow", "primary", () => actions.decide("allow")),
        ),
      );
      requestSection.append(requestBody, requestStatus);
    }
  }

  const search = h("input", { class: "tool-input", placeholder: "Search YouTube or the web…" }) as HTMLInputElement;
  const youtube = btn("YouTube", "secondary", () => {
    const q = search.value.trim();
    if (q) actions.openUrl(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`);
  });
  const web = btn("Web", "secondary", () => {
    const q = search.value.trim();
    if (q) actions.openUrl(`https://www.google.com/search?q=${encodeURIComponent(q)}`);
  });
  const writing = h("div", { class: "tool-row" },
    h("span", { class: "tool-label", text: "Writing assistant" }),
    ...(["Draft", "Rewrite", "Summarize"] as const).map((kind) => btn(kind, "secondary", () => {
      State.promptPrefill = `${kind} this for me: `;
      actions.setView("prompt");
    })),
  );
  const timerLabel = h("strong", { class: "timer-value", text: "25:00" });
  const timerStatus = h("span", { class: "tool-muted", text: "Focus timer ready" });
  const timerButtons = h("div", { class: "tool-actions" });
  let timerSeconds = Number(localStorage.getItem("act3.focusSeconds") ?? 1500);
  let timerRunning = false;
  let lastTimerTick = performance.now();
  const renderTimer = () => {
    timerLabel.textContent = `${String(Math.floor(timerSeconds / 60)).padStart(2, "0")}:${String(timerSeconds % 60).padStart(2, "0")}`;
    timerStatus.textContent = timerRunning ? "Focus timer running" : timerSeconds < 1500 ? "Focus timer paused" : "Focus timer ready";
  };
  const start = btn("Start", "primary", () => { timerRunning = true; renderTimer(); });
  const pause = btn("Pause", "secondary", () => { timerRunning = false; renderTimer(); });
  const reset = btn("Reset", "secondary", () => { timerRunning = false; timerSeconds = 1500; localStorage.setItem("act3.focusSeconds", "1500"); renderTimer(); });
  timerButtons.append(start, pause, reset);
  const alarmInput = h("input", { class: "tool-input", type: "datetime-local" }) as HTMLInputElement;
  const alarmList = h("div", { class: "alarm-list" });
  const alarms: { at: number; label: string }[] = JSON.parse(localStorage.getItem("act3.alarms") ?? "[]");
  const renderAlarms = () => {
    clear(alarmList);
    alarms.forEach((alarm, index) => alarmList.append(h("button", { class: "alarm", title: "Remove reminder", onclick: () => { alarms.splice(index, 1); localStorage.setItem("act3.alarms", JSON.stringify(alarms)); renderAlarms(); } }, `${new Date(alarm.at).toLocaleString()} · ${alarm.label} ×`)));
  };
  const addAlarm = btn("Add reminder", "secondary", async () => {
    if (!alarmInput.value) return;
    alarms.push({ at: new Date(alarmInput.value).getTime(), label: "ACT 3 reminder" });
    localStorage.setItem("act3.alarms", JSON.stringify(alarms));
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
    alarmInput.value = "";
    renderAlarms();
  });
  const taskInput = h("input", {
    class: "tool-input",
    placeholder: "Try: make a text file on desktop",
  }) as HTMLInputElement;
  const taskStatus = h("div", { class: "tool-muted", text: TASK_HELP });
  const runTask = btn("Run task", "primary", async () => {
    const plan = parseTask(taskInput.value);
    if (!plan) {
      taskStatus.textContent = `I couldn't match that to a safe task. ${TASK_HELP}`;
      return;
    }
    runTask.disabled = true;
    taskStatus.textContent = "Working…";
    try {
      const result = await executeTask(plan, {
        startFocusTimer(seconds) {
          timerSeconds = seconds;
          timerRunning = true;
          lastTimerTick = performance.now();
          localStorage.setItem("act3.focusSeconds", String(timerSeconds));
          renderTimer();
        },
        addReminder(at, label) {
          alarms.push({ at, label });
          localStorage.setItem("act3.alarms", JSON.stringify(alarms));
          if ("Notification" in window && Notification.permission === "default") {
            void Notification.requestPermission();
          }
          renderAlarms();
        },
        currentFile: () => State.activeDocument,
        setActiveFile(file) {
          State.activeDocument = file;
          State.notify();
        },
      });
      taskStatus.textContent = result.message;
    } finally {
      runTask.disabled = false;
    }
  }) as HTMLButtonElement;
  taskInput.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") {
      event.preventDefault();
      runTask.click();
    }
  });
  interface UserTask {
    id: string;
    name: string;
    instructions: string;
  }
  const userTaskName = h("input", {
    class: "tool-input",
    placeholder: "Task name",
    maxlength: "100",
  }) as HTMLInputElement;
  const userTaskInstructions = h("textarea", {
    class: "tool-textarea",
    placeholder: "Describe anything you want ACT 3 to help with…",
    maxlength: "4000",
    rows: "3",
  }) as HTMLTextAreaElement;
  const userTaskStatus = h("div", {
    class: "tool-muted",
    text: "Saved tasks run as prompts through your selected model; they do not change files or apps automatically.",
  });
  const userTaskList = h("div", { class: "saved-tasks" });
  const userTaskStorageKey = "act3.userTasks";
  const isUserTask = (value: unknown): value is UserTask =>
    typeof value === "object" &&
    value !== null &&
    "id" in value && typeof value.id === "string" &&
    "name" in value && typeof value.name === "string" &&
    "instructions" in value && typeof value.instructions === "string";
  let userTasks: UserTask[] = [];
  let editingTaskId: string | null = null;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(userTaskStorageKey) ?? "[]");
    if (!Array.isArray(saved) || !saved.every(isUserTask)) {
      throw new Error("Saved task data is invalid.");
    }
    userTasks = saved;
  } catch (error) {
    userTaskStatus.textContent = `Could not load saved tasks: ${String(error).replace(/^Error:\s*/, "")}`;
  }

  function persistUserTasks(next: UserTask[], message: string): boolean {
    try {
      localStorage.setItem(userTaskStorageKey, JSON.stringify(next));
      userTasks = next;
      userTaskStatus.textContent = message;
      renderUserTasks();
      return true;
    } catch (error) {
      userTaskStatus.textContent = `Could not save tasks: ${String(error).replace(/^Error:\s*/, "")}`;
      Sound.play("error");
      return false;
    }
  }

  function renderUserTasks() {
    clear(userTaskList);
    for (const task of userTasks) {
      const output = h("div", { class: "custom-task-output", hidden: true });
      const run = btn("Run", "primary", async () => {
        run.disabled = true;
        run.textContent = "Running…";
        output.hidden = false;
        output.textContent = "Working…";
        const previousOverride = State.stateOverride;
        State.stateOverride = "thinking";
        State.notify();
        try {
          const result = await Bridge.runCustomTask(task.instructions);
          output.textContent = result.text;
          Sound.play("finish");
          userTaskStatus.textContent = `Finished “${task.name}”.`;
        } catch (error) {
          output.textContent = `Task failed: ${String(error).replace(/^Error:\s*/, "")}`;
          Sound.play("error");
          userTaskStatus.textContent = `Could not run “${task.name}”.`;
        } finally {
          State.stateOverride = previousOverride;
          State.notify();
          run.disabled = false;
          run.textContent = "Run";
        }
      }) as HTMLButtonElement;
      const edit = btn("Edit", "secondary", () => {
        editingTaskId = task.id;
        userTaskName.value = task.name;
        userTaskInstructions.value = task.instructions;
        saveUserTask.textContent = "Update task";
        userTaskStatus.textContent = `Editing “${task.name}”.`;
      });
      const remove = btn("Remove", "secondary", () => {
        if (persistUserTasks(userTasks.filter((item) => item.id !== task.id), `Removed “${task.name}”.`) && editingTaskId === task.id) {
          resetUserTaskForm();
        }
      });
      userTaskList.append(
        h("div", { class: "saved-task" },
          h("strong", { class: "tool-label", text: task.name }),
          h("p", { class: "tool-muted", text: task.instructions }),
          h("div", { class: "tool-actions" }, run, edit, remove),
          output,
        ),
      );
    }
  }

  function resetUserTaskForm() {
    editingTaskId = null;
    userTaskName.value = "";
    userTaskInstructions.value = "";
    saveUserTask.textContent = "Add task";
  }

  const saveUserTask = btn("Add task", "secondary", () => {
    const name = userTaskName.value.trim();
    const instructions = userTaskInstructions.value.trim();
    if (!name || !instructions) {
      userTaskStatus.textContent = "Enter a task name and instructions first.";
      return;
    }
    if (name.length > 100 || instructions.length > 4000) {
      userTaskStatus.textContent = "Task names are limited to 100 characters and instructions to 4,000.";
      return;
    }
    if (!editingTaskId && userTasks.length >= 30) {
      userTaskStatus.textContent = "You can save up to 30 tasks.";
      return;
    }
    const task: UserTask = {
      id: editingTaskId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      instructions,
    };
    const next = editingTaskId
      ? userTasks.map((item) => item.id === editingTaskId ? task : item)
      : [...userTasks, task];
    if (persistUserTasks(next, editingTaskId ? `Updated “${name}”.` : `Saved “${name}”.`)) {
      resetUserTaskForm();
    }
  });
  renderUserTasks();
  const rootInput = h("input", { class: "tool-input", placeholder: "Folder root, e.g. C:\\Users\\you\\Documents" }) as HTMLInputElement;
  const workspaceKey = "act3.workspaceRoot";
  try {
    rootInput.value = localStorage.getItem(workspaceKey) ?? "";
  } catch (error) {
    console.error("[act3] could not load project folder", error);
  }
  const projectPrompt = h("textarea", {
    class: "tool-textarea code-prompt",
    placeholder: "Describe the code change you want, e.g. add a dark-mode toggle",
    maxlength: "4000",
    rows: "2",
  }) as HTMLTextAreaElement;
  const projectStatus = h("div", {
    class: "tool-muted",
    text: "Enter a project folder path. ACT 3 sends up to 40 source files (200 KB) to your selected model.",
  });
  const liveActivityStatus = h("div", {
    class: "tool-muted",
    text: "Waiting for a Claude Code session. Read, edit, and command activity will appear here.",
  });
  const liveActivityStages = h("div", { class: "live-code-stages" });
  const liveActivityTimeline = h("div", { class: "live-code-timeline" });
  const liveDiffList = h("div", { class: "live-diff-list" });
  const activitySummary = h("span", { class: "live-code-summary", text: "No activity yet" });
  let activityFilter: "all" | "edits" | "tools" = "all";
  const activityFilters = h("div", { class: "live-code-filters", role: "group", "aria-label": "Filter code activity" });
  const activityFilterButtons: HTMLButtonElement[] = [];
  for (const [value, label] of [
    ["all", "All"],
    ["edits", "Edits"],
    ["tools", "Tools"],
  ] as const) {
    const button = h("button", {
      class: "live-code-filter",
      type: "button",
      text: label,
      "aria-pressed": value === activityFilter,
    }) as HTMLButtonElement;
    button.addEventListener("click", () => {
      activityFilter = value;
      activityFilterButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      liveActivityPanel.dataset.key = "";
      renderLiveActivity();
    });
    activityFilterButtons.push(button);
    activityFilters.append(button);
  }
  const liveActivityPanel = h("div", { class: "tool-section live-code-panel" },
    h("div", { class: "live-code-heading" },
      h("span", { class: "live-code-pulse", "aria-hidden": "true" }),
      h("div", {},
        h("div", { class: "tool-title", text: "Live Claude Code session" }),
        h("div", { class: "tool-muted", text: "Observe tool activity and inspect file edits as they happen." }),
      ),
      h("span", { class: "live-code-state", text: "IDLE" }),
    ),
    h("div", { class: "live-code-toolbar" }, activitySummary, activityFilters),
    liveActivityStages,
    liveActivityStatus,
    liveActivityTimeline,
    liveDiffList,
  );
  const renderLiveActivity = () => {
    const entries = State.codeActivity.slice(-10).reverse();
    const changes = State.liveCodeChanges.slice(-8).reverse();
    const key = `${activityFilter}:${entries.map((entry) => `${entry.id}:${entry.status}`).join("|")}~${changes.map((change) => change.id).join("|")}`;
    if (liveActivityPanel.dataset.key === key) return;
    liveActivityPanel.dataset.key = key;
    clear(liveActivityStages);
    clear(liveActivityTimeline);
    clear(liveDiffList);
    if (entries.length === 0) {
      liveActivityStatus.textContent = "Waiting for a Claude Code session. Read, edit, and command activity will appear here.";
      liveActivityPanel.classList.remove("is-active");
      liveActivityPanel.querySelector(".live-code-state")!.textContent = "IDLE";
      activitySummary.textContent = "No activity yet";
      return;
    }
    const allEntries = State.codeActivity;
    const isActive = allEntries.some((entry) => entry.status === "running");
    liveActivityPanel.classList.toggle("is-active", isActive);
    liveActivityPanel.querySelector(".live-code-state")!.textContent = isActive ? "LIVE" : "SESSION";
    const changedFiles = new Set(State.liveCodeChanges.map((change) => change.path)).size;
    activitySummary.textContent = `${allEntries.length} events · ${changedFiles} ${changedFiles === 1 ? "file" : "files"} changed`;
    const stageTools: Record<string, string[]> = {
      Read: ["Read", "Glob", "Grep", "LS"],
      Edit: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
      Bash: ["Bash", "PowerShell"],
      Done: ["Done"],
    };
    for (const [stage, tools] of Object.entries(stageTools)) {
      const matched = allEntries.filter((entry) => tools.includes(entry.tool));
      const latest = matched.at(-1);
      const status = latest?.status ?? "pending";
      liveActivityStages.append(h("div", {
        class: `live-code-stage ${status}`,
        title: latest?.detail ?? `${stage} has not started`,
      },
        h("i", { class: "live-code-stage-icon", "aria-hidden": "true", text: status === "done" ? "✓" : status === "failed" ? "!" : status === "running" ? "·" : "○" }),
        h("span", { text: stage }),
      ));
    }
    const active = [...allEntries].reverse().find((entry) => entry.status === "running");
    const latestDone = [...allEntries].reverse().find((entry) => entry.tool === "Done");
    liveActivityStatus.textContent = active
      ? `${active.agentName} · ${active.tool}: ${active.detail}`
      : latestDone
      ? `${latestDone.agentName} finished this coding session.`
      : `${entries[0].agentName} · latest coding activity`;
    const editTools = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
    const visibleEntries = entries.filter((entry) => activityFilter === "all"
      || (activityFilter === "edits" ? editTools.has(entry.tool) : !editTools.has(entry.tool)));
    liveActivityTimeline.append(h("div", { class: "live-code-section-title", text: activityFilter === "edits" ? "File edits" : "Recent activity" }));
    if (!visibleEntries.length) {
      liveActivityTimeline.append(h("div", {
        class: "live-code-empty",
        text: activityFilter === "edits" ? "No file edits captured yet." : "No tool activity in this session yet.",
      }));
    }
    visibleEntries.forEach((entry) => liveActivityTimeline.append(h("div", {
      class: `live-code-event ${entry.status}`,
      title: new Date(entry.at).toLocaleTimeString(),
    },
      h("span", { class: "live-code-event-status", "aria-hidden": "true", text: entry.status === "running" ? "◌" : entry.status === "failed" ? "!" : "✓" }),
      h("strong", { text: entry.tool }),
      h("span", { text: entry.detail }),
    )));
    changes.forEach((change) => {
      const added = change.newText.split(/\r?\n/).length - (change.newText ? 0 : 1);
      const removed = change.oldText.split(/\r?\n/).length - (change.oldText ? 0 : 1);
      liveDiffList.append(h("details", { class: "live-diff-card" },
        h("summary", {},
          h("span", { class: "live-diff-file", text: change.path }),
          h("span", { class: "live-diff-counts" },
            h("i", { text: `+${Math.max(0, added)}` }),
            h("b", { text: `−${Math.max(0, removed)}` }),
          ),
        ),
        liveDiff(change),
      ));
    });
  };
  const projectProgress = h("div", {
    class: "code-progress",
    role: "status",
    "aria-live": "polite",
    hidden: true,
  },
    h("span", { class: "code-progress-orb", "aria-hidden": "true" }),
    h("span", { class: "code-progress-label", text: "Preparing project context and requesting a proposal. The reviewed changes appear after the model responds." }),
    h("div", { class: "code-progress-track", "aria-hidden": "true" }, h("i")),
  );
  const projectChanges = h("div", {
    class: "code-changes",
    role: "region",
    "aria-label": "Generated code changes awaiting approval",
  });
  const projectSummary = h("pre", { class: "project-summary", hidden: true });
  const editorSelect = document.createElement("select");
  editorSelect.className = "tool-input editor-select";
  for (const [value, label] of [
    ["vscode", "VS Code"],
    ["cursor", "Cursor"],
    ["system", "Default file manager"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    editorSelect.append(option);
  }
  const editorStorageKey = "act3.projectEditor";
  try {
    const preferred = localStorage.getItem(editorStorageKey);
    if (preferred && [...editorSelect.options].some((option) => option.value === preferred)) {
      editorSelect.value = preferred;
    }
  } catch (error) {
    console.error("[act3] could not load preferred editor", error);
  }
  editorSelect.addEventListener("change", () => {
    try {
      localStorage.setItem(editorStorageKey, editorSelect.value);
    } catch (error) {
      projectStatus.textContent = `Could not remember editor choice: ${String(error).replace(/^Error:\s*/, "")}`;
    }
  });
  const chooseProject = btn("Choose folder…", "secondary", async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose project folder",
      });
      if (!selected) return;
      rootInput.value = selected;
      rootInput.dispatchEvent(new Event("change"));
      projectStatus.textContent = `Selected project folder: ${selected}`;
    } catch (error) {
      projectStatus.textContent = `Could not choose project folder: ${String(error).replace(/^Error:\s*/, "")}`;
    }
  });
  const openProject = btn("Open project", "secondary", async () => {
    const root = rootInput.value.trim();
    if (!root) {
      projectStatus.textContent = "Enter the project folder path first.";
      return;
    }
    try {
      await Bridge.openProjectInEditor(
        root,
        selectedProjectEditor(editorSelect),
      );
      projectStatus.textContent = `Project opened in ${editorSelect.selectedOptions[0]?.textContent ?? "editor"}.`;
    } catch (error) {
      projectStatus.textContent = String(error).replace(/^Error:\s*/, "");
    }
  }) as HTMLButtonElement;
  const summarizeProject = btn("Summarize project", "secondary", async () => {
    const root = rootInput.value.trim();
    if (!root) {
      projectStatus.textContent = "Choose a project folder first.";
      return;
    }
    summarizeProject.disabled = true;
    projectSummary.hidden = true;
    projectStatus.textContent = "Inspecting a bounded set of project source files…";
    try {
      const summary = await Bridge.summarizeProject(root);
      projectSummary.textContent = summary;
      projectSummary.hidden = false;
      projectStatus.textContent = "Project summary ready. No project files were changed.";
    } catch (error) {
      projectStatus.textContent = String(error).replace(/^Error:\s*/, "");
    } finally {
      summarizeProject.disabled = false;
    }
  }) as HTMLButtonElement;
  const useProjectInAsk = btn("Ask about project", "secondary", () => {
    const root = rootInput.value.trim();
    if (!root) {
      projectStatus.textContent = "Choose a project folder first.";
      return;
    }
    document.dispatchEvent(new CustomEvent("act3:attach-project-context", { detail: { root } }));
    actions.setView("prompt");
  });
  const copyProjectSummary = btn("Copy summary", "secondary", async () => {
    if (projectSummary.hidden || !projectSummary.textContent) return;
    try {
      await Bridge.copyTextToClipboard(projectSummary.textContent);
      projectStatus.textContent = "Project summary copied.";
    } catch (error) {
      projectStatus.textContent = String(error).replace(/^Error:\s*/, "");
    }
  });
  const applyProposal = btn("Accept & apply changes", "primary", async () => {
    const proposal = currentProposal;
    const root = currentProposalRoot;
    if (!proposal || !root) return;
    applyProposal.disabled = true;
    try {
      const paths = await Bridge.applyCodeChanges(root, proposal.changes);
      currentProposal = null;
      currentProposalRoot = null;
      clear(projectChanges);
      askView.dismissCodeReview?.();
      projectStatus.textContent = `Updated ${paths.length} file(s): ${paths.join(", ")}`;
      Sound.play("finish");
      try {
        await Bridge.openProjectInEditor(
          root,
          selectedProjectEditor(editorSelect),
        );
      } catch (error) {
        projectStatus.textContent += ` · Could not open editor: ${String(error).replace(/^Error:\s*/, "")}`;
      }
    } catch (error) {
      projectStatus.textContent = String(error).replace(/^Error:\s*/, "");
      Sound.play("error");
    } finally {
      applyProposal.disabled = false;
    }
  }) as HTMLButtonElement;
  const rejectProposal = btn("Reject changes", "secondary", () => {
    if (!currentProposal) return;
    currentProposal = null;
    currentProposalRoot = null;
    clear(projectChanges);
    askView.dismissCodeReview?.();
    projectStatus.textContent = "Proposal rejected. No project files were changed.";
  });
  let currentProposal: CodeProposal | null = null;
  let currentProposalRoot: string | null = null;
  function renderCodeProposal(proposal: CodeProposal) {
    clear(projectChanges);
    projectChanges.append(
      h("div", { class: "code-review-heading" },
        h("span", { class: "code-review-icon", "aria-hidden": "true", text: "!" }),
        h("div", {},
          h("strong", { class: "tool-label", text: "Review required · no files changed yet" }),
          h("div", { class: "tool-muted", text: proposal.summary }),
        ),
      ),
      h("div", { class: "code-review-count", text: `${proposal.changes.length} file(s) proposed · inspect each diff before approving` }),
    );
    proposal.changes.forEach((change, index) => {
      const previous = change.originalContents ?? "(New file)";
      const details = h("details", { class: "code-change" },
        h("summary", { text: change.path }),
        h("div", { class: "code-change-panes" },
          h("pre", { text: `Before\n${previous}` }),
          h("pre", { text: `After\n${change.contents}` }),
        ),
      );
      details.style.setProperty("--change-index", String(index));
      projectChanges.append(details);
    });
    projectChanges.append(
      h("div", { class: "code-review-permission", text: "ACT 3 cannot write these edits until you explicitly approve them. Rejecting discards this proposal." }),
      h("div", { class: "tool-actions code-review-actions" }, rejectProposal, applyProposal),
    );
  }
  const generateCode = btn("Generate code", "primary", async () => {
    const root = rootInput.value.trim();
    const instructions = projectPrompt.value.trim();
    if (!root || !instructions) {
      projectStatus.textContent = "Enter a project folder and describe the code change.";
      return;
    }
    generateCode.disabled = true;
    applyProposal.disabled = true;
    currentProposal = null;
    currentProposalRoot = null;
    clear(projectChanges);
    askView.dismissCodeReview?.();
    projectProgress.hidden = false;
    projectStatus.textContent = "Working on a proposal. No files will be changed during generation.";
    generateCode.textContent = "Generating…";
    Sound.play("send");
    try {
      localStorage.setItem(workspaceKey, root);
      const proposal = await Bridge.generateCodeChanges(root, instructions);
      currentProposal = proposal;
      currentProposalRoot = root;
      projectStatus.textContent = "Proposal ready. Review the diffs and choose Accept & apply changes or Reject changes.";
      renderCodeProposal(proposal);
      askView.showCodeReview?.(projectChanges, () => {
        projectChangesSlot.append(projectChanges);
        projectStatus.textContent = "Proposal ready in Ask → Code. Review it whenever you are ready.";
      });
      Sound.play("finish");
    } catch (error) {
      projectStatus.textContent = String(error).replace(/^Error:\s*/, "");
      Sound.play("error");
    } finally {
      projectProgress.hidden = true;
      generateCode.disabled = false;
      generateCode.textContent = "Generate code";
      applyProposal.disabled = false;
    }
  }) as HTMLButtonElement;
  rootInput.addEventListener("change", () => {
    try {
      localStorage.setItem(workspaceKey, rootInput.value.trim());
      if (currentProposal && rootInput.value.trim() !== currentProposalRoot) {
        currentProposal = null;
        currentProposalRoot = null;
        clear(projectChanges);
        askView.dismissCodeReview?.();
        projectStatus.textContent = "Project folder changed. The pending proposal was discarded; generate a fresh proposal for this folder.";
      }
    } catch (error) {
      projectStatus.textContent = `Could not remember project folder: ${String(error).replace(/^Error:\s*/, "")}`;
    }
  });
  const fileQuery = h("input", { class: "tool-input", placeholder: "File name contains…" }) as HTMLInputElement;
  const fileStatus = h("div", { class: "tool-muted", text: "Search and read stay inside the selected root." });
  const fileResults = h("div", { class: "file-results" });
  const fileContent = h("textarea", { class: "tool-textarea", placeholder: "Read file content or generated text…" }) as HTMLTextAreaElement;
  const filePath = h("input", { class: "tool-input", placeholder: "relative/path.txt" }) as HTMLInputElement;
  const createConfirm = h("input", { type: "checkbox" }) as HTMLInputElement;
  const searchFiles = btn("Search files", "secondary", async () => {
    fileStatus.textContent = "Searching…";
    clear(fileResults);
    try {
      const matches = await Bridge.searchFiles(rootInput.value, fileQuery.value);
      fileStatus.textContent = `${matches.length} result(s).`;
      matches.forEach((match) => fileResults.append(h("button", { class: "file-result", onclick: async () => {
        filePath.value = match.path;
        try { fileContent.value = await Bridge.readTextFile(rootInput.value, match.path); fileStatus.textContent = `Read ${match.name}.`; }
        catch (error) { fileStatus.textContent = String(error).replace(/^Error:\s*/, ""); }
      } }, `${match.path} · ${match.size} bytes`)));
    } catch (error) { fileStatus.textContent = String(error).replace(/^Error:\s*/, ""); }
  });
  const copyText = btn("Copy text", "secondary", async () => {
    try { await Bridge.copyTextToClipboard(fileContent.value); fileStatus.textContent = "Copied to clipboard."; }
    catch (error) { fileStatus.textContent = String(error).replace(/^Error:\s*/, ""); }
  });
  const createFile = btn("Create file", "secondary", async () => {
    if (!createConfirm.checked) { fileStatus.textContent = "Check the confirmation box before creating a file."; return; }
    try {
      const created = await Bridge.createTextFile(rootInput.value, filePath.value, fileContent.value, true);
      fileStatus.textContent = `Created ${created}.`;
      createConfirm.checked = false;
    } catch (error) { fileStatus.textContent = String(error).replace(/^Error:\s*/, ""); }
  });
  const mcpStatus = h("div", {
    class: "tool-muted",
    text: "Add trusted local MCP servers in Settings to discover app tools.",
  });
  const mcpServerSelect = document.createElement("select");
  mcpServerSelect.className = "tool-input";
  const mcpToolList = h("div", { class: "mcp-tool-list" });
  const mcpReview = h("div", { class: "mcp-review", hidden: true });
  const mcpArguments = h("textarea", {
    class: "tool-textarea",
    placeholder: "Tool arguments as JSON",
    value: "{}",
  }) as HTMLTextAreaElement;
  const mcpResult = h("pre", { class: "mcp-result", hidden: true });
  let selectedMcpTool: McpTool | null = null;
  let currentMcpTools: McpTool[] = [];
  const refreshMcpTools = async () => {
    const serverId = mcpServerSelect.value;
    if (!serverId) {
      mcpStatus.textContent = "Add and enable a local MCP server in Settings.";
      clear(mcpToolList);
      return;
    }
    mcpStatus.textContent = "Connecting to the configured MCP server…";
    clear(mcpToolList);
    mcpResult.hidden = true;
    mcpReview.hidden = true;
    try {
      currentMcpTools = await Bridge.mcpListTools(serverId);
      if (mcpServerSelect.value !== serverId) return;
      mcpStatus.textContent = `${currentMcpTools.length} tool(s) discovered. Choose a tool to review its arguments.`;
      for (const tool of currentMcpTools) {
        mcpToolList.append(h("button", {
          class: "mcp-tool-item",
          type: "button",
          text: `${tool.serverName} · ${tool.name}`,
          onclick: () => {
            selectedMcpTool = tool;
            mcpArguments.value = "{}";
            mcpResult.hidden = true;
            mcpReview.hidden = false;
            clear(mcpReview);
            mcpReview.append(
              h("strong", { text: `${tool.serverName} → ${tool.name}` }),
              h("div", { class: "tool-muted", text: tool.description || "No description provided by server." }),
              h("pre", { class: "mcp-schema", text: JSON.stringify(tool.inputSchema, null, 2) }),
            );
          },
        }));
      }
    } catch (error) {
      mcpStatus.textContent = `Could not connect: ${String(error).replace(/^Error:\s*/, "")}`;
    }
  };
  const mcpRefreshButton = btn("Discover tools", "secondary", () => void refreshMcpTools());
  mcpServerSelect.addEventListener("change", () => {
    selectedMcpTool = null;
    void refreshMcpTools();
  });
  const mcpRunButton = btn("Review tool call", "secondary", () => {
    if (!selectedMcpTool) {
      mcpStatus.textContent = "Select a tool first.";
      return;
    }
    try {
      JSON.parse(mcpArguments.value);
    } catch {
      mcpStatus.textContent = "Arguments must be valid JSON.";
      return;
    }
    mcpReview.hidden = false;
    clear(mcpReview);
    mcpReview.append(
      h("div", { class: "hook-request-heading", text: "Review before running" }),
      h("div", { class: "tool-muted", text: `Server: ${selectedMcpTool.serverName} · Tool: ${selectedMcpTool.name}` }),
      h("pre", { class: "mcp-schema", text: mcpArguments.value }),
      h("div", { class: "tool-actions" },
        btn("Deny", "secondary", () => {
          mcpReview.hidden = true;
          mcpStatus.textContent = "Tool call denied; the MCP server was not invoked.";
        }),
        (() => {
          const allow = h("button", {
            class: "btn primary",
            text: "Allow once",
            onclick: async () => {
          allow.disabled = true;
          mcpStatus.textContent = "Running the approved tool…";
          try {
            const output = await Bridge.mcpCallTool(
              selectedMcpTool!.serverId,
              selectedMcpTool!.name,
              JSON.parse(mcpArguments.value),
              true,
            );
            mcpResult.textContent = output;
            mcpResult.hidden = false;
            mcpStatus.textContent = "Tool completed.";
            mcpReview.hidden = true;
          } catch (error) {
            mcpStatus.textContent = `Tool failed: ${String(error).replace(/^Error:\s*/, "")}`;
            allow.disabled = false;
          }
            },
          }) as HTMLButtonElement;
          return allow;
        })(),
      ),
    );
  });
  const syncMcpServers = () => {
    const current = mcpServerSelect.value;
    const configured = State.settings.mcpServers ?? [];
    const ids = configured.map((server) => `${server.id}:${server.enabled}`).join("|");
    if (mcpServerSelect.dataset.ids === ids) return;
    mcpServerSelect.replaceChildren();
    configured.filter((server) => server.enabled).forEach((server) => {
      mcpServerSelect.append(h("option", { value: server.id, text: server.name }));
    });
    mcpServerSelect.value = configured.some((server) => server.id === current && server.enabled)
      ? current
      : configured.find((server) => server.enabled)?.id ?? "";
    mcpServerSelect.dataset.ids = ids;
  };
  syncMcpServers();
  const mcpSection = h("div", { class: "tool-section mcp-tools" },
    h("div", { class: "tool-title", text: "Connected app tools (MCP)" }),
    h("div", { class: "tool-muted", text: "Only trusted servers configured in Settings are started. Each tool call requires your explicit approval." }),
    h("div", { class: "tool-row" }, mcpServerSelect, mcpRefreshButton),
    mcpToolList,
    mcpArguments,
    h("div", { class: "tool-row" }, mcpRunButton),
    mcpReview,
    mcpResult,
    mcpStatus,
  );
  const desktopStatus = h("div", { class: "tool-muted", "aria-live": "polite" });
  const desktopInstruction = h("input", {
    class: "tool-input",
    type: "text",
    maxlength: "1000",
    placeholder: "Describe one action in the shared app…",
  }) as HTMLInputElement;
  const desktopScreenshot = h("img", {
    class: "desktop-screenshot",
    alt: "Screenshot ACT 3 will use for a proposed desktop action",
    hidden: true,
  }) as HTMLImageElement;
  const desktopReview = h("div", { class: "desktop-action-review", hidden: true });
  const desktopRequest = btn("Propose one action", "secondary", async () => {
    const capture = State.attachedWindowCapture;
    const instruction = desktopInstruction.value.trim();
    if (!capture) {
      desktopStatus.textContent = "Share an app screenshot in Ask first.";
      return;
    }
    if (!instruction) {
      desktopStatus.textContent = "Describe what you want ACT 3 to do in the shared app.";
      desktopInstruction.focus();
      return;
    }
    desktopRequest.disabled = true;
    State.pendingDesktopAction = null;
    desktopReview.hidden = true;
    State.notify();
    desktopStatus.textContent = `Sending the screenshot and request to ${State.chatAgent}. Cloud bots send them to their configured provider.`;
    try {
      const proposal = await Bridge.proposeWindowAction(instruction, capture, State.chatAgent);
      State.attachedWindowCapture = proposal.capture;
      if (!proposal.action) {
        desktopStatus.textContent = proposal.summary;
        State.notify();
        return;
      }
      State.pendingDesktopAction = {
        windowId: proposal.capture.windowId,
        appName: proposal.capture.appName,
        title: proposal.capture.title,
        width: proposal.capture.width,
        height: proposal.capture.height,
        summary: proposal.summary,
        action: proposal.action,
      };
      desktopStatus.textContent = "Review the exact action below. Nothing runs until you choose Allow once.";
      State.notify();
    } catch (error) {
      desktopStatus.textContent = `Could not propose an action: ${String(error).replace(/^Error:\s*/, "")}`;
    } finally {
      desktopRequest.disabled = false;
    }
  }) as HTMLButtonElement;
  const windowActionLabel = (action: WindowAction) => {
    switch (action.kind) {
      case "click": return `Click at ${action.x}, ${action.y}`;
      case "type": return `Type: ${action.text}`;
      case "hotkey": return `Press ${action.keys.join(" + ")}`;
    }
  };
  const renderDesktopReview = () => {
    const pending = State.pendingDesktopAction;
    if (!pending) {
      desktopReview.hidden = true;
      clear(desktopReview);
      return;
    }
    desktopReview.hidden = false;
    clear(desktopReview);
    desktopReview.append(
      h("div", { class: "hook-request-heading", text: "One desktop action needs approval" }),
      h("div", { class: "tool-muted", text: `${pending.appName} · ${pending.title}` }),
      h("div", { class: "desktop-action-summary", text: pending.summary }),
      h("pre", { class: "mcp-schema", text: windowActionLabel(pending.action) }),
      h("div", { class: "tool-muted", text: "Only this single click, printable text entry, or navigation key will run. Review the target and exact text." }),
      h("div", { class: "tool-actions" },
        btn("Deny", "secondary", () => {
          State.pendingDesktopAction = null;
          desktopStatus.textContent = "Desktop action denied; nothing was sent.";
          State.notify();
        }),
        (() => {
          const allow = h("button", {
            class: "btn primary",
            type: "button",
            text: "Allow once",
            onclick: async () => {
              allow.disabled = true;
              desktopStatus.textContent = "Checking the selected window and running the approved action…";
              try {
                await Bridge.performWindowAction(
                  pending.windowId,
                  pending.appName,
                  pending.title,
                  pending.width,
                  pending.height,
                  pending.action,
                  true,
                );
                State.pendingDesktopAction = null;
                desktopStatus.textContent = "The approved action completed.";
                State.notify();
              } catch (error) {
                desktopStatus.textContent = `Action did not run: ${String(error).replace(/^Error:\s*/, "")}`;
                allow.disabled = false;
              }
            },
          }) as HTMLButtonElement;
          return allow;
        })(),
      ),
    );
  };
  const desktopSection = h("div", { class: "tool-section desktop-control" },
    h("div", { class: "tool-title", text: "Help with a shared app" }),
    h("div", {
      class: "tool-muted",
      text: "Capture a window in Ask, then request one safe action. The selected AI receives the screenshot; cloud bots send it to their configured endpoint. Review and allow each action here.",
    }),
    desktopScreenshot,
    h("div", { class: "tool-row" }, desktopInstruction, desktopRequest),
    desktopReview,
    desktopStatus,
  );
  let renderedDesktopCapture: typeof State.attachedWindowCapture = null;

  const projectChangesSlot = h("div", { class: "code-review-slot" }, projectChanges);
  const el = h("div", { class: "view tools-view" },
    card("indigo", h("div", { class: "tool-grid" },
      requestSection,
      mcpApprovalSection,
      liveActivityPanel,
      h("div", { class: "tool-section task-runner" },
        h("div", { class: "tool-title", text: "Quick actions" }),
        h("div", { class: "tool-row quick-task-row" }, taskInput, runTask),
        taskStatus,
      ),
      h("div", { class: "tool-section task-maker" },
        h("div", { class: "tool-title", text: "Make your own task" }),
        h("div", { class: "tool-muted", text: "Name it, describe what you want, then save and run it whenever you like." }),
        userTaskName,
        userTaskInstructions,
        h("div", { class: "tool-row" }, saveUserTask),
        userTaskStatus,
        userTaskList,
      ),
      h("div", { class: "tool-section" }, h("div", { class: "tool-title", text: "Search" }), h("div", { class: "tool-row" }, search, youtube, web)),
      h("div", { class: "tool-section" }, writing),
      mcpSection,
      desktopSection,
      h("div", { class: "tool-section timer-section" }, timerLabel, timerStatus, timerButtons),
      h("div", { class: "tool-section" }, h("div", { class: "tool-title", text: "Reminders" }), h("div", { class: "tool-row" }, alarmInput, addAlarm), alarmList),
      h("div", { class: "tool-section code-agent" },
        h("div", { class: "tool-title", text: "Code with ACT 3" }),
        h("div", { class: "tool-muted", text: "Describe a code change; ACT 3 reads a bounded set of source files, generates edits, and can apply them in this project. It never runs commands." }),
        h("div", { class: "tool-row project-path-row" }, rootInput, chooseProject, editorSelect, openProject),
        h("div", { class: "tool-row project-actions" }, summarizeProject, useProjectInAsk, copyProjectSummary),
        projectSummary,
        projectPrompt,
        projectProgress,
        h("div", { class: "tool-row code-agent-actions" },
          h("span", { class: "tool-muted", text: "Every generated edit waits for your review and approval." }),
          generateCode,
        ),
        projectStatus,
        projectChangesSlot,
      ),
      h("div", { class: "tool-section file-tools" },
        h("div", { class: "tool-title", text: "File tools" }),
        h("div", { class: "tool-row" }, fileQuery, searchFiles),
        fileResults,
        filePath,
        fileContent,
        h("div", { class: "tool-row" }, copyText, createConfirm, h("span", { class: "tool-muted", text: "I confirm creating this new text file" }), createFile),
        fileStatus,
      ),
    )),
  );
  return {
    el,
    sync() {
      renderPendingRequest();
      renderMcpApprovals();
      renderLiveActivity();
      syncMcpServers();
      const capture = State.attachedWindowCapture;
      if (capture) {
        if (capture !== renderedDesktopCapture) {
          renderedDesktopCapture = capture;
          desktopScreenshot.src = `data:image/png;base64,${capture.pngBase64}`;
        }
        desktopScreenshot.alt = `Current screenshot of ${capture.appName}: ${capture.title}`;
        desktopScreenshot.hidden = false;
      } else {
        renderedDesktopCapture = null;
        desktopScreenshot.hidden = true;
        desktopScreenshot.removeAttribute("src");
      }
      renderDesktopReview();
      const nowMs = performance.now();
      if (timerRunning && timerSeconds > 0) {
        const elapsed = Math.floor((nowMs - lastTimerTick) / 1000);
        if (elapsed > 0) {
          timerSeconds = Math.max(0, timerSeconds - elapsed);
          lastTimerTick += elapsed * 1000;
          localStorage.setItem("act3.focusSeconds", String(timerSeconds));
          if (timerSeconds === 0) { timerRunning = false; timerStatus.textContent = "Focus complete"; }
          renderTimer();
        }
      }
      const now = Date.now();
      for (let i = alarms.length - 1; i >= 0; i--) {
        if (alarms[i].at <= now) {
          const label = alarms[i].label;
          alarms.splice(i, 1);
          localStorage.setItem("act3.alarms", JSON.stringify(alarms));
          if ("Notification" in window && Notification.permission === "granted") new Notification("ACT 3 reminder", { body: label });
        }
      }
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  const prompt = buildPrompt(onChatHeightChange);
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("ACT 3 is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  const tools = buildTools(actions, prompt);
  const toolGrid = tools.el.querySelector(".tool-grid");
  if (toolGrid) {
    const codePanel = h("div", { class: "ask-inline-panel", "data-ask-panel": "code" });
    for (const child of Array.from(toolGrid.children)) {
      if (child.classList.contains("hook-request")) continue;
      if (child.classList.contains("code-agent") || child.classList.contains("live-code-panel")) {
        codePanel.append(child);
      }
    }
    if (!codePanel.childElementCount) {
      codePanel.append(h("div", { class: "tool-muted", text: "Code tools are unavailable." }));
    }
    prompt.attachAskPanels?.([
      { id: "code", label: "Code", element: codePanel },
    ], () => tools.sync(), (nowMs) => tools.tick?.(nowMs));
  }
  map.set("prompt", prompt);
  map.set("tools", tools);
  return map;
}
