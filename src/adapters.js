import { invoke } from "@tauri-apps/api/core";

const browserDefaults = {
  provider: "ollama",
  model: "llama3.2",
  baseUrl: "https://api.openai.com/v1",
  ollamaUrl: "http://127.0.0.1:11434",
  apiKeySet: false
};

export function isNativeApp() {
  return Boolean(window.__TAURI_INTERNALS__);
}

export async function loadSettings() {
  if (!isNativeApp()) return browserDefaults;
  return invoke("get_settings");
}

export async function saveSettings(settings) {
  if (!isNativeApp()) return { ...settings, apiKeySet: Boolean(settings.apiKey) };
  return invoke("save_settings", { input: settings });
}

export async function sendMessage(message) {
  if (!isNativeApp()) {
    await new Promise((resolve) => setTimeout(resolve, 420));
    return "The browser preview is UI-only. Launch `npm run tauri:dev` to connect Ollama or an online provider.";
  }
  return invoke("send_message", { request: { message } });
}
