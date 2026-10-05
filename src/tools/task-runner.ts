import { Bridge } from "../core/bridge";

export type TaskPlan =
  | { kind: "openUrl"; url: string }
  | { kind: "search"; query: string }
  | { kind: "openPath"; path: string }
  | { kind: "openCurrentFile" }
  | { kind: "createDesktopNote"; name?: string }
  | { kind: "createNote"; path: string; contents: string }
  | { kind: "copyText"; contents: string }
  | { kind: "focusTimer"; seconds: number }
  | { kind: "reminder"; at: number; label: string };

export type TaskResult =
  | { ok: true; message: string }
  | { ok: false; message: string; needsConfirmation?: boolean };

export interface TaskRunnerHooks {
  startFocusTimer(seconds: number): void;
  addReminder(at: number, label: string): void;
  currentFile(): { name: string; path: string } | null;
  setActiveFile(file: { name: string; path: string }): void;
}

const MAX_TIMER_SECONDS = 24 * 60 * 60;
const MAX_TEXT_LENGTH = 100_000;

function durationSeconds(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
  const seconds = Math.round(amount * multiplier);
  return seconds > 0 && seconds <= MAX_TIMER_SECONDS ? seconds : null;
}

function localPath(value: string): string | null {
  const path = value.trim().replace(/^["']|["']$/g, "");
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") ? path : null;
}

function splitNote(value: string): { path: string; contents: string } | null {
  const match = value.trim().match(/^(.+?)\s*:\s+([\s\S]+)$/);
  if (!match) return null;
  const path = localPath(match[1]);
  const contents = match[2].trim();
  return path && contents.length <= MAX_TEXT_LENGTH ? { path, contents } : null;
}

function reminderTime(value: string): { at: number; label: string } | null {
  const relative = value.match(/^in\s+(.+?)\s+to\s+(.+)$/i);
  if (relative) {
    const seconds = durationSeconds(relative[1]);
    if (seconds) return { at: Date.now() + seconds * 1000, label: relative[2].trim() };
  }
  const absolute = value.match(/^at\s+(.+?)\s+to\s+(.+)$/i);
  if (absolute) {
    const at = new Date(absolute[1]).getTime();
    if (Number.isFinite(at) && at > Date.now()) return { at, label: absolute[2].trim() };
  }
  return null;
}

export function parseTask(input: string): TaskPlan | null {
  const text = input.trim();
  if (!text) return null;

  if (/^(?:(?:please|can you|could you)\s+)?(?:open|show)\s+(?:this|it|that|the (?:file|document|note))(?:\s+please)?[.!?]*$/i.test(text)) {
    return { kind: "openCurrentFile" };
  }

  const desktopNote = text.match(
    /^(?:make|create|new)\s+(?:me\s+)?(?:a\s+)?(?:blank\s+)?(?:text\s+)?(?:file|note)(?:\s+(?:named|called)\s+["']?([^"']+?)["']?)?(?:\s+(?:on|in)\s+(?:my\s+)?desktop)?$/i,
  ) ?? text.match(
    /^(?:make|create|new)\s+(?:me\s+)?(?:a\s+)?(?:blank\s+)?(?:text\s+)?(?:file|note)\s+(?:on|in)\s+(?:my\s+)?desktop(?:\s+(?:named|called)\s+["']?([^"']+?)["']?)?$/i,
  );
  if (desktopNote) return { kind: "createDesktopNote", name: desktopNote[1]?.trim() };

  const url = text.match(/^(?:open|go to)\s+(https?:\/\/\S+)$/i);
  if (url) return { kind: "openUrl", url: url[1] };

  const search = text.match(/^(?:search|google|look up)\s+(.+)$/i);
  if (search) return { kind: "search", query: search[1].trim() };

  const openPath = text.match(/^open\s+(?:file|folder|path)\s+(.+)$/i) ?? text.match(/^open\s+([A-Za-z]:[\\/].+)$/i);
  if (openPath) {
    const path = localPath(openPath[1]);
    if (path) return { kind: "openPath", path };
  }

  const note = text.match(/^(?:create|new)\s+(?:a\s+)?(?:text\s+)?note\s+(.+)$/i);
  if (note) {
    const parsed = splitNote(note[1]);
    if (parsed) return { kind: "createNote", ...parsed };
  }

  const copy = text.match(/^copy(?:\s+to\s+clipboard)?\s+([\s\S]+)$/i);
  if (copy && copy[1].length <= MAX_TEXT_LENGTH) return { kind: "copyText", contents: copy[1] };

  const timer = text.match(/^(?:start|set)\s+(?:a\s+)?(?:focus\s+)?timer\s+(?:for\s+)?(.+)$/i);
  if (timer) {
    const seconds = durationSeconds(timer[1]);
    if (seconds) return { kind: "focusTimer", seconds };
  }

  const reminder = text.match(/^remind\s+me\s+(.+)$/i);
  if (reminder) {
    const parsed = reminderTime(reminder[1]);
    if (parsed) return { kind: "reminder", ...parsed };
  }

  return null;
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;
  return `${seconds} second(s)`;
}

export async function executeTask(
  plan: TaskPlan,
  hooks: TaskRunnerHooks,
): Promise<TaskResult> {
  try {
    switch (plan.kind) {
      case "openUrl":
        await Bridge.openUrl(plan.url);
        return { ok: true, message: "Opened the URL in your browser." };
      case "search":
        await Bridge.openUrl(`https://www.google.com/search?q=${encodeURIComponent(plan.query)}`);
        return { ok: true, message: "Opened the search in your browser." };
      case "openPath":
        await Bridge.openLocalPath(plan.path);
        return { ok: true, message: "Opened the selected local path." };
      case "openCurrentFile": {
        const file = hooks.currentFile();
        if (!file) return { ok: false, message: "Drop a file onto ACT 3 first, or create a Desktop note." };
        await Bridge.openLocalPath(file.path);
        return { ok: true, message: `Opened ${file.name}.` };
      }
      case "createDesktopNote": {
        const file = await Bridge.createDesktopTextFile(plan.name);
        hooks.setActiveFile(file);
        await Bridge.openLocalPath(file.path);
        return { ok: true, message: `Created and opened ${file.name} on your Desktop. You can now ask ACT 3 to write in it.` };
      }
      case "createNote": {
        const separator = Math.max(plan.path.lastIndexOf("\\"), plan.path.lastIndexOf("/"));
        const root = separator > 0 ? plan.path.slice(0, separator) : plan.path;
        const relative = separator > 0 ? plan.path.slice(separator + 1) : "note.txt";
        const created = await Bridge.createTextFile(root, relative, plan.contents, true);
        const separatorChar = root.includes("/") && !root.includes("\\") ? "/" : "\\";
        const path = `${root}${separatorChar}${created}`;
        hooks.setActiveFile({ name: relative, path });
        await Bridge.openLocalPath(path);
        return { ok: true, message: `Created and opened ${relative}. You can now ask ACT 3 to write in it.` };
      }
      case "copyText":
        await Bridge.copyTextToClipboard(plan.contents);
        return { ok: true, message: "Copied the text to the clipboard." };
      case "focusTimer":
        hooks.startFocusTimer(plan.seconds);
        return { ok: true, message: `Started a ${formatDuration(plan.seconds)} focus timer.` };
      case "reminder":
        hooks.addReminder(plan.at, plan.label);
        return { ok: true, message: `Reminder set for ${new Date(plan.at).toLocaleString()}.` };
    }
  } catch (error) {
    return { ok: false, message: String(error).replace(/^Error:\s*/, "") };
  }
}

export const TASK_HELP =
  "Try “open this”, “make a text file on desktop”, “search cats”, “start a 25 minute timer”, or “remind me in 10 minutes to stretch”.";
