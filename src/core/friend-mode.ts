import { Bridge, IS_TAURI } from "./bridge";
import { State } from "./state";
import type { Island } from "../island/island";

const MIN_IDLE_SECONDS = 5 * 60;
const FRIEND_PROMPT =
  "Write a brief, warm hello to the person using ACT 3. Start with “Hi from ACT 3!” or a similarly friendly greeting, then ask one gentle, low-pressure question. Do not assume or claim anything about what they are doing or how they feel. Return only the greeting; do not mention this instruction or that it was sent automatically.";

function islandIsOpen(): boolean {
  return State.mode !== "hidden";
}

export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export class FriendMode {
  private timer: number | null = null;
  private requesting = false;

  constructor(private readonly island: Island) {}

  refresh() {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    if (IS_TAURI && State.settings.friendModeEnabled && !this.requesting) {
      this.schedule();
    }
  }

  private schedule() {
    const min = Math.max(15, State.settings.friendModeMinMinutes);
    const max = Math.max(min, State.settings.friendModeMaxMinutes);
    const delayMinutes = min + Math.floor(Math.random() * (max - min + 1));
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.maybeSayHello();
    }, delayMinutes * 60_000);
  }

  private async maybeSayHello() {
    if (!State.settings.friendModeEnabled) return;
    this.requesting = true;
    try {
      const hour = new Date().getHours();
      if (
        State.paused ||
        islandIsOpen() ||
        isQuietHour(hour, State.settings.friendModeQuietStartHour, State.settings.friendModeQuietEndHour)
      ) return;

      if (await Bridge.systemIdleSeconds() < MIN_IDLE_SECONDS) return;
      const agent = State.chatAgent;
      const reply = await Bridge.chatSend(FRIEND_PROMPT, null, agent);

      if (
        !State.settings.friendModeEnabled ||
        State.paused ||
        State.chatAgent !== agent ||
        islandIsOpen() ||
        isQuietHour(new Date().getHours(), State.settings.friendModeQuietStartHour, State.settings.friendModeQuietEndHour) ||
        await Bridge.systemIdleSeconds() < MIN_IDLE_SECONDS
      ) return;

      const history = State.chatHistories[agent];
      const id = history.reduce((maxId, message) => Math.max(maxId, message.id), 0) + 1;
      history.push({ id, role: "assistant", content: reply.text });
      State.stateOverride = null;
      this.island.alert("prompt");
    } catch (error) {
      void Bridge.log(`AI friend hello was skipped: ${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      this.requesting = false;
      this.refresh();
    }
  }
}
