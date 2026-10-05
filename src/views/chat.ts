// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ChatContext, type ChatReply } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";
import { appendMarkdown } from "./markdown";

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  appendMarkdown(reply, message.content);
  return h("div", { class: "chat-row" }, reply);
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
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;
  let appliedPrefill = false;

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
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
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const writeToActiveFile = Boolean(
      active && /\b(?:write|type|put|draft|compose|add|replace|update)\b/i.test(query) &&
      /\b(?:in|into)\s+(?:that|this|the)\s+(?:notepad|file|document|note)\b/i.test(query),
    );
    const context: ChatContext | null = file
      ? { kind: "file", name: file.name, path: file.path, ...(writeToActiveFile && active ? { writePath: active.path } : {}) }
      : writeToActiveFile && active
        ? { kind: "file", name: active.name, path: active.path, writePath: active.path }
      : null;

    try {
      const reply: ChatReply = await Bridge.chatSend(query, context);
      State.chatHistory.push({
        id: nextId++,
        role: "assistant",
        content: reply.writtenFile
          ? `${reply.text}\n\nSaved the updated text to ${reply.writtenFile}.`
          : reply.text,
      });
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
      const file = State.droppedFile;
      const wantChip = State.activeDocument?.name ?? file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      input.placeholder = State.chatHistory.length === 0
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
