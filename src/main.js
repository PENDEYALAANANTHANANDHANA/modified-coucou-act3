import "./styles.css";
import { isNativeApp, loadSettings, saveSettings, sendMessage } from "./adapters.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

const app = document.querySelector("#app");
let settings = await loadSettings();
let soundMuted = localStorage.getItem("act3.soundMuted") === "true";
let audioContext;
let islandState = "compact";
let droppedFile = null;
let retractTimer;

app.innerHTML = `
  <section class="island-shell" aria-label="ACT 3 Windows desk companion">
    <div class="island state-compact" data-island>
      <div class="island-topline">
        <div class="brand-mark" aria-hidden="true"><span>✦</span></div>
        <div class="status-copy"><strong>ACT 3</strong><span><i class="status-dot"></i> <span data-status>here with you</span></span></div>
        <div class="topline-actions">
          <button class="icon-button" data-action="mute" aria-label="Unmute sound" title="Sound">◒</button>
          <button class="icon-button" data-action="settings" aria-label="Open ACT 3 settings" title="Settings">⚙</button>
          <button class="icon-button expand-button" data-action="toggle" aria-label="Peek ACT 3 open" title="Peek ACT 3 open">⌄</button>
        </div>
      </div>
      <div class="buddy-stage" data-dropzone tabindex="0" aria-label="Drop a file here to give ACT 3 context">
        <div class="spark spark-one">✦</div><div class="spark spark-two">·</div>
        <div class="buddy" data-buddy aria-label="Animated ACT 3 companion">
          <div class="ear ear-left"></div><div class="ear ear-right"></div>
          <div class="face"><span class="eye eye-left"></span><span class="eye eye-right"></span><span class="cheek cheek-left"></span><span class="cheek cheek-right"></span><span class="mouth"></span></div>
          <div class="body"><span class="belly"></span></div><div class="foot foot-left"></div><div class="foot foot-right"></div>
        </div>
        <div class="buddy-caption"><span data-mood>softly cheering you on</span><b>♡</b></div>
      </div>
      <div class="quick-actions" aria-label="Quick actions">
        <button class="quick-action" data-prompt="Help me focus on one task"><span>◒</span>Focus</button>
        <button class="quick-action" data-prompt="Give me a tiny reset"><span>↻</span>Reset</button>
        <button class="quick-action" data-prompt="Help me pick a next step"><span>✦</span>Next step</button>
      </div>
      <div class="state-switcher" role="tablist" aria-label="ACT 3 view">
        <button class="state-tab active" data-state="overview" role="tab" aria-selected="true">Overview</button>
        <button class="state-tab" data-state="chat" role="tab" aria-selected="false">Chat</button>
      </div>
      <div class="drop-hint" data-drop-hint>Drop a file on ACT 3 for context</div>
      <div class="chat-panel" data-chat-panel hidden>
        <div class="chat-log" data-chat-log aria-live="polite"><div class="message mochi-message"><span class="message-avatar">✦</span><p>Good to see you. What would feel useful right now?</p></div></div>
        <div class="typing-indicator" data-typing hidden><span></span><span></span><span></span><em>ACT 3 is thinking</em></div>
        <form class="chat-form" data-chat-form><label class="sr-only" for="message">Message ACT 3</label><input id="message" data-message-input autocomplete="off" placeholder="Talk to ACT 3..." /><button type="submit" aria-label="Send message">↗</button></form>
        <small class="provider-note" data-provider-note></small>
      </div>
      <div class="settings-panel" data-settings-panel hidden>
        <div class="panel-heading"><strong>AI settings</strong><button class="text-button" data-action="close-settings">Done</button></div>
        <p class="settings-help">Ollama stays on this PC. Online uses an OpenAI-compatible endpoint. Credentials are stored only in this app's local data folder.</p>
        <label>Provider<select data-setting="provider"><option value="ollama">Ollama (local)</option><option value="online">Online / OpenAI-compatible</option></select></label>
        <label>Model<input data-setting="model" placeholder="llama3.2" /></label>
        <label data-online-setting>Online base URL<input data-setting="baseUrl" placeholder="https://api.openai.com/v1" /></label>
        <label data-online-setting>API key<input type="password" data-setting="apiKey" placeholder="Leave blank to keep saved key" /></label>
        <label data-ollama-setting>Ollama URL<input data-setting="ollamaUrl" placeholder="http://127.0.0.1:11434" /></label>
        <button class="save-button" data-action="save-settings">Save settings</button>
        <small class="settings-result" data-settings-result></small>
      </div>
    </div>
  </section>
`;

const island = app.querySelector("[data-island]");
const chatPanel = app.querySelector("[data-chat-panel]");
const settingsPanel = app.querySelector("[data-settings-panel]");
const chatLog = app.querySelector("[data-chat-log]");
const form = app.querySelector("[data-chat-form]");
const input = app.querySelector("[data-message-input]");
const buddy = app.querySelector("[data-buddy]");
const mood = app.querySelector("[data-mood]");
const status = app.querySelector("[data-status]");
const providerNote = app.querySelector("[data-provider-note]");
const typing = app.querySelector("[data-typing]");
const muteButton = app.querySelector("[data-action=mute]");
const dropzone = app.querySelector("[data-dropzone]");
const dropHint = app.querySelector("[data-drop-hint]");
const tabs = [...app.querySelectorAll("[data-state]")];

async function centerAtTop() {
  if (!isNativeApp()) return;
  try {
    const window = getCurrentWindow();
    const monitor = await window.currentMonitor();
    if (monitor) {
      const scale = monitor.scaleFactor;
      const width = 446 * scale;
      const x = monitor.position.x + Math.round((monitor.size.width - width) / 2);
      await window.setPosition(new PhysicalPosition(x, monitor.position.y));
    }
  } catch {
    // Browser preview and older native shells can use the configured position.
  }
}

function playSound(kind) {
  if (soundMuted) return;
  audioContext ??= new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = kind === "send" ? 440 : 660;
  gain.gain.setValueAtTime(0.035, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.12);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.12);
}

function updateMuteButton() {
  muteButton.textContent = soundMuted ? "◌" : "◒";
  muteButton.setAttribute("aria-label", soundMuted ? "Unmute ACT 3 sounds" : "Mute ACT 3 sounds");
  muteButton.title = soundMuted ? "Sound muted" : "Sound on";
}

function setState(nextState) {
  islandState = nextState;
  island.classList.remove("state-compact", "state-overview", "state-chat");
  island.classList.add(`state-${nextState}`);
  chatPanel.hidden = nextState !== "chat";
  app.querySelector("[data-action=toggle]").textContent = nextState === "compact" ? "⌄" : "⌃";
  app.querySelector("[data-action=toggle]").setAttribute("aria-label", nextState === "compact" ? "Peek ACT 3 open" : "Retract ACT 3");
  tabs.forEach((tab) => {
    const active = tab.dataset.state === (nextState === "compact" ? "overview" : nextState);
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  if (nextState === "chat") input.focus();
}

function setExpanded(expanded) {
  setState(expanded ? "chat" : "compact");
}

function updateSettingsForm() {
  for (const [key, value] of Object.entries(settings)) {
    const field = app.querySelector(`[data-setting="${key}"]`);
    if (field && key !== "apiKeySet") field.value = value ?? "";
  }
  app.querySelector("[data-setting=apiKey]").value = "";
  app.querySelectorAll("[data-online-setting]").forEach((element) => { element.hidden = settings.provider !== "online"; });
  app.querySelectorAll("[data-ollama-setting]").forEach((element) => { element.hidden = settings.provider !== "ollama"; });
}

function addMessage(text, role = "user") {
  const message = document.createElement("div");
  message.className = `message ${role === "user" ? "user-message" : "mochi-message"}`;
  message.innerHTML = role === "user" ? `<p>${escapeHtml(text)}</p>` : `<span class="message-avatar">✦</span><p>${escapeHtml(text)}</p>`;
  chatLog.append(message);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));
}

async function runMessage(text) {
  const value = text.trim();
  if (!value) return;
  setState("chat");
  addMessage(value);
  input.value = "";
  buddy.classList.add("thinking");
  mood.textContent = "thinking softly...";
  typing.hidden = false;
  playSound("send");
  try {
    addMessage(await sendMessage(value), "mochi");
    playSound("receive");
  } catch (error) {
    addMessage(error?.toString?.() ?? "The provider could not respond.", "mochi");
  } finally {
    buddy.classList.remove("thinking");
    typing.hidden = true;
    mood.textContent = "softly cheering you on";
  }

  function showDroppedFile(file) {
    droppedFile = file;
    dropHint.textContent = `${file.name} ready as context`;
    dropHint.classList.add("has-file");
    addMessage(`I have ${file.name} ready as context. Ask me about it when your provider is connected.`, "mochi");
    setState("chat");
  }
}

function showSettings(show) {
  settingsPanel.hidden = !show;
  if (show) updateSettingsForm();
}

function refreshProviderLabel() {
  const label = settings.provider === "ollama" ? `Ollama · ${settings.model}` : `online · ${settings.model}${settings.apiKeySet ? "" : " · key not set"}`;
  providerNote.textContent = isNativeApp() ? label : "browser preview · launch the native app for AI";
  status.textContent = settings.provider === "ollama" ? "local AI ready" : "online AI ready";
}

app.querySelector("[data-action=toggle]").addEventListener("click", () => setState(islandState === "compact" ? "overview" : "compact"));
island.addEventListener("mouseenter", () => {
  clearTimeout(retractTimer);
  if (islandState === "compact") setState("overview");
});
island.addEventListener("mouseleave", () => {
  if (islandState === "overview") {
    retractTimer = setTimeout(() => setState("compact"), 900);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    showSettings(false);
    setState("compact");
  }
});
muteButton.addEventListener("click", () => {
  soundMuted = !soundMuted;
  localStorage.setItem("act3.soundMuted", String(soundMuted));
  updateMuteButton();
  if (!soundMuted) playSound("receive");
});
app.querySelector("[data-action=settings]").addEventListener("click", () => showSettings(true));
app.querySelector("[data-action=close-settings]").addEventListener("click", () => showSettings(false));
tabs.forEach((tab) => tab.addEventListener("click", () => setState(tab.dataset.state)));
dropzone.addEventListener("dragenter", (event) => {
  event.preventDefault();
  island.classList.add("is-dragging");
  setState("overview");
});
dropzone.addEventListener("dragover", (event) => event.preventDefault());
dropzone.addEventListener("dragleave", () => island.classList.remove("is-dragging"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  island.classList.remove("is-dragging");
  const [file] = event.dataTransfer.files;
  if (file) showDroppedFile(file);
});
app.querySelector("[data-setting=provider]").addEventListener("change", (event) => {
  settings.provider = event.target.value;
  updateSettingsForm();
});
app.querySelector("[data-action=save-settings]").addEventListener("click", async () => {
  const next = Object.fromEntries(["provider", "model", "baseUrl", "ollamaUrl", "apiKey"].map((key) => [key, app.querySelector(`[data-setting="${key}"]`).value.trim()]));
  try {
    settings = await saveSettings(next);
    app.querySelector("[data-settings-result]").textContent = "Saved locally.";
    refreshProviderLabel();
    updateMuteButton();
    centerAtTop();
    updateSettingsForm();
  } catch (error) {
    app.querySelector("[data-settings-result]").textContent = error?.toString?.() ?? "Could not save settings.";
  }
});
form.addEventListener("submit", (event) => { event.preventDefault(); runMessage(input.value); });
app.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => runMessage(button.dataset.prompt)));

refreshProviderLabel();
