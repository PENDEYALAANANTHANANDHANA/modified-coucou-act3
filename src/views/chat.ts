// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ChatContext, type ChatReply } from "../core/bridge";
import { Sound } from "../core/sound";
import { CHAT_AGENTS, State, type ChatAgentId, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";
import { appendMarkdown } from "./markdown";
import { createMiniBot } from "../mochi/minibots";

let nextId = 1;

function bubble(message: ChatMessage, agent: ChatAgentId): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  appendMarkdown(reply, message.content);
  return h(
    "div",
    { class: "chat-row assistant", style: `--agent-color:${CHAT_AGENTS[agent].color}` },
    h("i", { class: "chat-reply-dot", title: CHAT_AGENTS[agent].name }),
    reply,
  );
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const agentGrid = h("div", { class: "chat-agent-grid" });
  const agentOptions = h("div", {
    class: "chat-agent-options",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Choose one or more ACT 3 bots",
  });
  const agentPicker = h("div", { class: "chat-agent-picker" });
  const selectedAgents: ChatAgentId[] = [State.chatAgent];
  let pickerOpen = false;
  let sending = false;
  let agentSelectionChanged = false;
  const agentTrigger = h("button", {
    class: "chat-agent-trigger",
    type: "button",
    "aria-expanded": "false",
    "aria-haspopup": "true",
    title: "Choose one or more ACT 3 chat bots",
  }) as HTMLButtonElement;
  const agentButtons = new Map<ChatAgentId, HTMLButtonElement>();
  const agentModels = new Map<ChatAgentId, HTMLElement>();
  for (const agent of ["omniroute", "openrouter", "ollama"] as const) {
    const details = CHAT_AGENTS[agent];
    const modelLabel = h("small", { class: "chat-agent-model" });
    const mascot = createMiniBot({
      id: `chat-${agent}`,
      name: details.name,
      color: details.color,
      state: "idle",
      stepIndex: 0,
      steps: [],
      source: "agent",
      isIntegration: false,
    }, 28, null);
    mascot.classList.add("chat-agent-mascot");
    const button = h(
      "button",
      {
        class: `chat-agent-button agent-${agent}`,
        type: "button",
        "aria-pressed": "false",
        style: `--agent-color:${details.color}`,
        title: `${details.name}: ${details.purpose}`,
      },
      h("span", { class: "chat-agent-check", "aria-hidden": "true" }),
      mascot,
      h("span", { class: "chat-agent-copy" },
        h("strong", { text: details.name }),
        h("small", { text: details.purpose }),
        modelLabel,
      ),
    ) as HTMLButtonElement;
    button.addEventListener("click", () => {
      if (sending) return;
      agentSelectionChanged = true;
      const selectedIndex = selectedAgents.indexOf(agent);
      if (selectedIndex >= 0) {
        if (selectedAgents.length === 1) return;
        selectedAgents.splice(selectedIndex, 1);
        if (State.chatAgent === agent) State.setChatAgent(selectedAgents[0]);
      } else {
        selectedAgents.push(agent);
        State.setChatAgent(agent);
      }
      syncAgentOptions();
      State.notify();
      onHeightChange();
      input.focus();
    });
    agentButtons.set(agent, button);
    agentModels.set(agent, modelLabel);
    agentGrid.append(button);
  }
  const closePicker = h("button", {
    class: "chat-agent-done",
    type: "button",
    text: "Done",
    onclick: () => {
      pickerOpen = false;
      syncAgentOptions();
      agentTrigger.focus();
    },
  });
  agentOptions.append(
    h("div", { class: "chat-agent-options-heading" },
      h("div", {},
        h("strong", { text: "Choose your ACT 3 bots" }),
        h("small", {
          class: "chat-agent-hint",
          text: "Choose more than one to get separate answers. File edits use the primary bot.",
        }),
      ),
      closePicker,
    ),
    agentGrid,
  );
  function syncAgentOptions() {
    document.body.classList.toggle("chat-agent-picker-open", pickerOpen);
    if (!agentSelectionChanged && selectedAgents[0] !== State.chatAgent) {
      selectedAgents.splice(0, selectedAgents.length, State.chatAgent);
    }
    const names = selectedAgents.map((agent) => CHAT_AGENTS[agent].name);
    agentTrigger.replaceChildren(
      createMiniBot({
        id: "chat-agent-trigger",
        name: "ACT 3",
        color: "#a78bfa",
        state: "idle",
        stepIndex: 0,
        steps: [],
        source: "agent",
        isIntegration: false,
      }, 22, null),
      h("strong", { text: "ACT 3" }),
      h("span", {
        class: "chat-agent-selected-count",
        text: `${selectedAgents.length} ${selectedAgents.length === 1 ? "bot" : "bots"}`,
      }),
      h("span", { class: "chat-agent-selected-dots", "aria-hidden": "true" },
        ...selectedAgents.map((agent) => h("i", {
          style: `background:${CHAT_AGENTS[agent].color}`,
          title: CHAT_AGENTS[agent].name,
        })),
      ),
    );
    agentTrigger.setAttribute("aria-expanded", String(pickerOpen));
    agentTrigger.title = `Selected: ${names.join(", ")}. Click to choose bots.`;
    agentOptions.hidden = !pickerOpen;
    for (const agent of ["omniroute", "openrouter", "ollama"] as const) {
      const button = agentButtons.get(agent)!;
      button.classList.toggle("selected", selectedAgents.includes(agent));
      button.setAttribute("aria-pressed", String(selectedAgents.includes(agent)));
      button.disabled = sending;
      agentModels.get(agent)!.textContent = State.settings[CHAT_AGENTS[agent].modelSetting];
    }
  }
  agentTrigger.addEventListener("click", () => {
    pickerOpen = !pickerOpen;
    syncAgentOptions();
  });
  document.addEventListener("act3:open-agent-picker", () => {
    if (State.view !== "prompt" || pickerOpen) return;
    pickerOpen = true;
    syncAgentOptions();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!pickerOpen || agentPicker.contains(event.target as Node)) return;
    pickerOpen = false;
    syncAgentOptions();
  });
  agentPicker.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape" || !pickerOpen) return;
    pickerOpen = false;
    syncAgentOptions();
    agentTrigger.focus();
  });
  agentPicker.append(agentTrigger, agentOptions);
  syncAgentOptions();
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, agentPicker, chipRow, log, bar)),
  );
  const card = el.querySelector(".card") as HTMLElement;
  card.style.setProperty("--wash", "rgba(167,139,250,0.38)");

  let renderedKey = "";
  let appliedPrefill = false;

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    if (pickerOpen) {
      pickerOpen = false;
      syncAgentOptions();
    }
    const active = State.activeDocument;
    if (/^(?:(?:please|can you|could you)\s+)?(?:open|show)\s+(?:this|it|that|the (?:file|document|note))(?:\s+please)?[.!?]*$/i.test(query)) {
      if (!active) {
        State.noteMessage = "Drop a file onto ACT 3 first, or create a Desktop note from Tools.";
        State.view = "note";
        State.notify();
        return;
      }
      try {
        await Bridge.openLocalPath(active.path);
        State.chatHistory.push({ id: nextId++, role: "assistant", content: `Opened ${active.name}.` });
      } catch (err) {
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        State.view = "note";
      }
      State.notify();
      onHeightChange();
      return;
    }

    input.value = "";
    sending = true;
    const isWritingActiveFile = Boolean(
      active && /\b(?:write|type|put|draft|compose|add|replace|update)\b/i.test(query) &&
      /\b(?:in|into)\s+(?:that|this|the)\s+(?:notepad|file|document|note)\b/i.test(query),
    );
    const targets = isWritingActiveFile ? [State.chatAgent] : [...selectedAgents];
    Sound.play("send");

    const userMessage = { id: nextId++, role: "user" as const, content: query };
    for (const agent of targets) State.chatHistories[agent].push(userMessage);
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const files = State.droppedFiles;
    const file = State.droppedFile;
    const writeToActiveFile = isWritingActiveFile;
    const context: ChatContext | null = files.length > 1
      ? { kind: "files", files }
      : file
      ? { kind: "file", name: file.name, path: file.path, ...(writeToActiveFile && active ? { writePath: active.path } : {}) }
      : writeToActiveFile && active
      ? { kind: "file", name: active.name, path: active.path, writePath: active.path }
      : null;

    try {
      await Promise.all(targets.map(async (agent) => {
        try {
          const reply: ChatReply = await Bridge.chatSend(query, context, agent);
          State.chatHistories[agent].push({
            id: nextId++,
            role: "assistant",
            content: reply.writtenFile
              ? `${reply.text}\n\nSaved the updated text to ${reply.writtenFile}.`
              : reply.text,
          });
        } catch (err) {
          State.chatHistories[agent].push({
            id: nextId++,
            role: "assistant",
            content: `Could not reach ${CHAT_AGENTS[agent].name}: ${String(err).replace(/^Error:\s*/, "")}`,
          });
        }
      }));
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      if (!appliedPrefill && State.promptPrefill) {
        input.value = State.promptPrefill;
        State.promptPrefill = "";
        appliedPrefill = true;
      }
      syncAgentOptions();
      card.style.setProperty(
        "--wash",
        State.chatAgent === "omniroute" ? "rgba(167,139,250,0.38)"
          : State.chatAgent === "openrouter" ? "rgba(251,146,60,0.34)"
            : "rgba(52,211,153,0.32)",
      );
      const file = State.droppedFile;
      const wantChip = State.droppedFiles.length > 1
        ? `${State.droppedFiles.length} documents`
        : State.activeDocument?.name ?? file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking";
      const visibleMessages = selectedAgents.flatMap((agent) =>
        State.chatHistories[agent].map((message) => ({ agent, message })),
      ).sort((a, b) => a.message.id - b.message.id);
      const seenUserMessages = new Set<number>();
      const distinctMessages = visibleMessages.filter(({ message }) => {
        if (message.role !== "user") return true;
        if (seenUserMessages.has(message.id)) return false;
        seenUserMessages.add(message.id);
        return true;
      });
      const key = `${selectedAgents.join(",")}:${distinctMessages.map(({ agent, message }) => `${agent}:${message.id}`).join(",")}:${thinking}`;
      if (key !== renderedKey) {
        renderedKey = key;
        clear(log);
        for (const { agent, message } of distinctMessages) log.append(bubble(message, agent));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      input.placeholder = distinctMessages.length === 0
        ? "Ask me anything…"
        : State.activeDocument
          ? "Ask about it, or say “write in this file…”"
          : "Continue…";
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
