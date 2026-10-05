// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { Bridge } from "../core/bridge";
import { executeTask, parseTask, TASK_HELP } from "../tools/task-runner";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
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
    { class: `btn ${kind}`, onclick: onClick },
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
    actions.blip();
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
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
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

function buildTools(actions: ViewActions): ViewHost {
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
    placeholder: "Try: start focus timer 25 minutes",
  }) as HTMLInputElement;
  const taskStatus = h("div", { class: "tool-muted", text: TASK_HELP });
  const taskConfirm = h("input", { type: "checkbox" }) as HTMLInputElement;
  const runTask = btn("Run task", "primary", async () => {
    const plan = parseTask(taskInput.value);
    if (!plan) {
      taskStatus.textContent = `I couldn't match that to a safe task. ${TASK_HELP}`;
      return;
    }
    taskStatus.textContent = "Working…";
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
    }, taskConfirm.checked);
    taskStatus.textContent = result.message;
    if (result.ok || !result.needsConfirmation) taskConfirm.checked = false;
  });
  const rootInput = h("input", { class: "tool-input", placeholder: "Folder root, e.g. C:\\Users\\you\\Documents" }) as HTMLInputElement;
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
  const el = h("div", { class: "view tools-view" },
    card("indigo", h("div", { class: "tool-grid" },
      h("div", { class: "tool-section task-runner" },
        h("div", { class: "tool-title", text: "Simple task runner" }),
        h("div", { class: "tool-row" }, taskInput, runTask),
        h("div", { class: "tool-row" }, taskConfirm, h("span", { class: "tool-muted", text: "I confirm creating a new note" })),
        taskStatus,
      ),
      h("div", { class: "tool-section" }, h("div", { class: "tool-title", text: "Search" }), h("div", { class: "tool-row" }, search, youtube, web)),
      h("div", { class: "tool-section" }, writing),
      h("div", { class: "tool-section timer-section" }, timerLabel, timerStatus, timerButtons),
      h("div", { class: "tool-section" }, h("div", { class: "tool-title", text: "Reminders" }), h("div", { class: "tool-row" }, alarmInput, addAlarm), alarmList),
      h("div", { class: "tool-section file-tools" },
        h("div", { class: "tool-title", text: "Safe file tools" }),
        rootInput,
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
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  map.set("tools", buildTools(actions));
  return map;
}
