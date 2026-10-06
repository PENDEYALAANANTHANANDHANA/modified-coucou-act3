// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask, type PendingQuestion } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { Bridge, type CodeProposal } from "../core/bridge";
import { Sound } from "../core/sound";
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

function buildTools(actions: ViewActions): ViewHost {
  const requestSection = h("div", { class: "tool-section hook-request", hidden: true });
  const requestBody = h("div", { class: "hook-request-body" });
  const requestStatus = h("div", { class: "tool-muted hook-request-status" });
  let renderedRequest = "";

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
  const projectChanges = h("div", { class: "code-changes" });
  const autoApply = h("input", { type: "checkbox" }) as HTMLInputElement;
  const openProject = btn("Open in VS Code", "secondary", async () => {
    const root = rootInput.value.trim();
    if (!root) {
      projectStatus.textContent = "Enter the project folder path first.";
      return;
    }
    try {
      const opened = await Bridge.openInVSCode(root);
      projectStatus.textContent = opened
        ? "Project opened in VS Code."
        : "VS Code's `code` command was not found. Install/enable the VS Code command-line launcher.";
    } catch (error) {
      projectStatus.textContent = String(error).replace(/^Error:\s*/, "");
      if (currentProposal) {
        autoApply.checked = false;
        projectStatus.textContent += " Review the proposal before trying to apply it.";
        renderCodeProposal(currentProposal);
      }
    }
  });
  const applyProposal = btn("Apply changes", "primary", async () => {
    const proposal = currentProposal;
    const root = currentProposalRoot;
    if (!proposal || !root) return;
    applyProposal.disabled = true;
    try {
      const paths = await Bridge.applyCodeChanges(root, proposal.changes);
      currentProposal = null;
      currentProposalRoot = null;
      clear(projectChanges);
      projectStatus.textContent = `Updated ${paths.length} file(s): ${paths.join(", ")}`;
      try {
        const opened = await Bridge.openInVSCode(root);
        if (!opened) projectStatus.textContent += " · VS Code's `code` command was not found.";
      } catch (error) {
        projectStatus.textContent += ` · Could not open VS Code: ${String(error).replace(/^Error:\s*/, "")}`;
      }
    } catch (error) {
      projectStatus.textContent = String(error).replace(/^Error:\s*/, "");
    } finally {
      applyProposal.disabled = false;
    }
  }) as HTMLButtonElement;
  let currentProposal: CodeProposal | null = null;
  let currentProposalRoot: string | null = null;
  function renderCodeProposal(proposal: CodeProposal) {
    clear(projectChanges);
    projectChanges.append(h("strong", { class: "tool-label", text: proposal.summary }));
    for (const change of proposal.changes) {
      const previous = change.originalContents ?? "(New file)";
      const details = h("details", { class: "code-change" },
        h("summary", { text: change.path }),
        h("div", { class: "code-change-panes" },
          h("pre", { text: `Before\n${previous}` }),
          h("pre", { text: `After\n${change.contents}` }),
        ),
      );
      projectChanges.append(details);
    }
    applyProposal.hidden = autoApply.checked;
    if (!autoApply.checked) projectChanges.append(applyProposal);
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
    projectStatus.textContent = "Reading project source and asking your selected model…";
    try {
      localStorage.setItem(workspaceKey, root);
      const proposal = await Bridge.generateCodeChanges(root, instructions);
      currentProposal = proposal;
      currentProposalRoot = root;
      if (autoApply.checked) {
        const paths = await Bridge.applyCodeChanges(root, proposal.changes);
        currentProposal = null;
        currentProposalRoot = null;
        projectStatus.textContent = `Automatically updated ${paths.length} file(s): ${paths.join(", ")}`;
        try {
          const opened = await Bridge.openInVSCode(root);
          if (!opened) projectStatus.textContent += " · VS Code's `code` command was not found.";
        } catch (error) {
          projectStatus.textContent += ` · Could not open VS Code: ${String(error).replace(/^Error:\s*/, "")}`;
        }
      } else {
        projectStatus.textContent = "Review the generated files, then choose Apply changes.";
        renderCodeProposal(proposal);
      }
    } catch (error) {
      projectStatus.textContent = String(error).replace(/^Error:\s*/, "");
    } finally {
      generateCode.disabled = false;
      applyProposal.disabled = false;
    }
  }) as HTMLButtonElement;
  autoApply.addEventListener("change", () => {
    if (currentProposal) renderCodeProposal(currentProposal);
  });
  rootInput.addEventListener("change", () => {
    try {
      localStorage.setItem(workspaceKey, rootInput.value.trim());
      if (currentProposal && rootInput.value.trim() !== currentProposalRoot) {
        currentProposal = null;
        currentProposalRoot = null;
        clear(projectChanges);
        projectStatus.textContent = "Project folder changed. Generate a fresh proposal for this folder.";
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
  const el = h("div", { class: "view tools-view" },
    card("indigo", h("div", { class: "tool-grid" },
      requestSection,
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
      h("div", { class: "tool-section timer-section" }, timerLabel, timerStatus, timerButtons),
      h("div", { class: "tool-section" }, h("div", { class: "tool-title", text: "Reminders" }), h("div", { class: "tool-row" }, alarmInput, addAlarm), alarmList),
      h("div", { class: "tool-section code-agent" },
        h("div", { class: "tool-title", text: "Code with ACT 3" }),
        h("div", { class: "tool-muted", text: "Describe a code change; ACT 3 reads a bounded set of source files, generates edits, and can apply them in this project. It never runs commands." }),
        h("div", { class: "tool-row project-path-row" }, rootInput, openProject),
        projectPrompt,
        h("div", { class: "tool-row code-agent-actions" }, autoApply, h("span", { class: "tool-muted", text: "Automatically apply generated edits without review" }), generateCode),
        projectStatus,
        projectChanges,
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
  const tools = buildTools(actions);
  const toolGrid = tools.el.querySelector(".tool-grid");
  if (toolGrid) {
    const taskPanel = h("div", { class: "ask-inline-panel", "data-ask-panel": "tasks" });
    const codePanel = h("div", { class: "ask-inline-panel", "data-ask-panel": "code" });
    const morePanel = h("div", { class: "ask-inline-panel", "data-ask-panel": "more" });
    for (const child of Array.from(toolGrid.children)) {
      if (child.classList.contains("hook-request")) continue;
      if (child.classList.contains("task-runner") || child.classList.contains("task-maker")) {
        taskPanel.append(child);
      } else if (child.classList.contains("code-agent")) {
        codePanel.append(child);
      } else {
        morePanel.append(child);
      }
    }
    if (!taskPanel.childElementCount) {
      taskPanel.append(h("div", { class: "tool-muted", text: "Task tools are unavailable." }));
    }
    if (!codePanel.childElementCount) {
      codePanel.append(h("div", { class: "tool-muted", text: "Code tools are unavailable." }));
    }
    prompt.attachAskPanels?.([
      { id: "tasks", label: "Tasks", element: taskPanel },
      { id: "code", label: "Code", element: codePanel },
      { id: "more", label: "More", element: morePanel },
    ], () => tools.sync(), (nowMs) => tools.tick?.(nowMs));
    toolGrid.append(h("div", {
      class: "tool-muted tools-moved-hint",
      text: "Tasks and Code are now available as tabs in Ask.",
    }));
  }
  map.set("prompt", prompt);
  map.set("tools", tools);
  return map;
}
