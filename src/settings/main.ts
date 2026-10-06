// Settings window — the place where anything that writes to disk is confirmed.

import "./settings.css";
import { Bridge, onEvent, type HookStatus, type UpdateStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "ACT 3 is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "act3-hook.exe is not in place yet. Restart ACT 3; if it still fails, build it with `cargo build -p act3-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes ACT 3's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

function mcpSection(): HTMLElement {
  const name = h("input", { class: "text-input", placeholder: "Display name, e.g. Local calendar" }) as HTMLInputElement;
  const command = h("input", { class: "text-input", placeholder: "Executable path, e.g. C:\\Tools\\my-mcp.exe" }) as HTMLInputElement;
  const args = h("input", { class: "text-input", placeholder: 'Arguments as JSON array, e.g. ["--stdio"]' }) as HTMLInputElement;
  const status = h("div", { class: "hint", text: "No MCP servers configured." });
  const servers = h("div", { class: "mcp-servers" });
  const section = h("section", {},
    h("h2", {}, statusDot(false), h("span", { text: "App integrations (MCP)" })),
    h("div", {
      class: "notice warn",
      text: "Only add MCP programs you trust. ACT 3 starts the configured executable with your Windows account permissions. Tool calls must be reviewed and approved from Tools.",
    }),
    h("div", { class: "hint", text: "Local stdio servers only. ACT 3 passes the executable and arguments directly; it does not run them through a shell." }),
    h("label", { text: "Server name" }), name,
    h("label", { text: "Executable" }), command,
    h("label", { text: "Arguments (JSON array)" }), args,
    h("div", { class: "row" },
      h("button", {
        class: "primary",
        text: "Add MCP server",
        onclick: async () => {
          const serverName = name.value.trim();
          const executable = command.value.trim();
          if (!serverName || !executable) {
            status.textContent = "Enter a server name and executable.";
            return;
          }
          let serverArgs: unknown;
          try {
            serverArgs = args.value.trim() ? JSON.parse(args.value) : [];
          } catch {
            status.textContent = "Arguments must be a valid JSON array of strings.";
            return;
          }
          if (!Array.isArray(serverArgs) || serverArgs.some((arg) => typeof arg !== "string")) {
            status.textContent = "Arguments must be a valid JSON array of strings.";
            return;
          }
          settings.mcpServers ??= [];
          if (settings.mcpServers.length >= 8) {
            status.textContent = "You can configure up to 8 MCP servers.";
            return;
          }
          settings.mcpServers.push({
            id: crypto.randomUUID(),
            name: serverName.slice(0, 80),
            command: executable.slice(0, 4096),
            args: serverArgs.slice(0, 64),
            enabled: true,
          });
          try {
            await save();
            name.value = "";
            command.value = "";
            args.value = "";
            render();
            status.textContent = "MCP server saved. Open Tools to discover its tools.";
          } catch (error) {
            status.textContent = `Could not save MCP server: ${String(error).replace(/^Error:\\s*/, "")}`;
          }
        },
      }),
    ),
    servers,
    status,
  );

  function render() {
    clear(servers);
    const configured = settings.mcpServers ?? [];
    if (!configured.length) {
      status.textContent = "No MCP servers configured.";
      return;
    }
    for (const server of configured) {
      const label = h("span", {
        class: "hint",
        text: `${server.enabled ? "Enabled" : "Disabled"} · ${server.command} ${server.args.join(" ")}`.trim(),
      });
      const toggleButton = h("button", {
        class: "secondary",
        text: server.enabled ? "Disable" : "Enable",
        onclick: async () => {
          server.enabled = !server.enabled;
          try {
            await save();
            render();
          } catch (error) {
            server.enabled = !server.enabled;
            status.textContent = `Could not update server: ${String(error).replace(/^Error:\\s*/, "")}`;
          }
        },
      });
      const removeButton = h("button", {
        class: "danger",
        text: "Remove",
        onclick: async () => {
          settings.mcpServers = configured.filter((item) => item.id !== server.id);
          try {
            await save();
            render();
          } catch (error) {
            settings.mcpServers = configured;
            status.textContent = `Could not remove server: ${String(error).replace(/^Error:\\s*/, "")}`;
          }
        },
      });
      servers.append(h("div", { class: "mcp-server-row" },
        h("strong", { text: server.name }),
        label,
        toggleButton,
        removeButton,
      ));
    }
  }
  render();
  return section;
}

// ── AI provider section ───────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["openrouter/auto", "OpenRouter Auto"],
  ["openai/gpt-4o-mini", "GPT-4o mini"],
  ["google/gemini-2.5-flash", "Gemini 2.5 Flash"],
];

function apiSection(): HTMLElement {
  const dot = statusDot(false);
  const state = h("span", { class: "hint", text: "Checking provider setup…" });
  let detectedOllamaModels: string[] = [];

  // ── Ollama status card ──────────────────────────────────────────────────
  const ollamaEndpoint = h("span", { class: "path", text: settings.ollamaUrl || "http://127.0.0.1:11434" });
  const ollamaSelectedModel = h("span", { class: "hint", text: settings.ollamaModel });
  const ollamaActiveDot = statusDot(false);
  const ollamaActiveLabel = h("span", { class: "hint", text: "checking…" });
  const ollamaModelCount = h("span", { class: "hint", text: "—" });

  const ollamaRefreshBtn = h("button", { class: "secondary", text: "↻ Refresh" });
  ollamaRefreshBtn.addEventListener("click", async () => {
    ollamaRefreshBtn.disabled = true;
    ollamaRefreshBtn.textContent = "Checking…";
    try {
      await save();
      await refreshAllStatus();
    } finally {
      ollamaRefreshBtn.disabled = false;
      ollamaRefreshBtn.textContent = "↻ Refresh";
    }
  });

  const ollamaTestBtn = h("button", { class: "secondary", text: "Test connection" });
  ollamaTestBtn.addEventListener("click", async () => {
    ollamaTestBtn.disabled = true;
    ollamaTestBtn.textContent = "Testing…";
    try {
      await save();
      const result = await Bridge.testProvider("ollama");
      ollamaActiveLabel.textContent = result;
      ollamaActiveLabel.style.color = "#22c55e";
      ollamaActiveDot.style.background = "#22c55e";
      await refreshAllStatus();
      ollamaActiveLabel.textContent = result;
    } catch (error) {
      ollamaActiveLabel.textContent = String(error).replace(/^Error:\s*/, "");
      ollamaActiveLabel.style.color = "#f4505e";
      ollamaActiveDot.style.background = "#f4505e";
    } finally {
      ollamaTestBtn.disabled = false;
      ollamaTestBtn.textContent = "Test connection";
    }
  });

  const ollamaCard = h(
    "div",
    { class: "provider-status-card ollama-status-card" },
    h("div", { style: "font:600 12px var(--font);color:var(--ink);display:flex;align-items:center;gap:6px" },
      h("span", { text: "Ollama" }),
    ),
    h("div", { class: "row" }, h("label", { text: "Endpoint" }), ollamaEndpoint),
    h("div", { class: "row" }, h("label", { text: "Selected model" }), ollamaSelectedModel),
    h("div", { class: "row" }, h("label", { text: "Status" }), ollamaActiveDot, ollamaActiveLabel),
    h("div", { class: "row" }, h("label", { text: "Models detected" }), ollamaModelCount),
    h("div", { class: "row" }, ollamaRefreshBtn, ollamaTestBtn),
  );

  // ── Online provider status ──────────────────────────────────────────────
  function keyBadge(present: boolean, name: string): HTMLElement {
    const badge = h("span", {
      style: `display:inline-flex;align-items:center;gap:4px;font:500 11px var(--font);padding:3px 8px;border-radius:6px;${
        present
          ? "color:#86efac;background:rgba(34,197,94,0.1)"
          : "color:#ff8d97;background:rgba(244,80,94,0.1)"
      }`,
      text: present ? `${name}: present ✓` : `${name}: missing ✗`,
    });
    return badge;
  }

  const openaiBadge = keyBadge(false, "OpenAI-compatible");
  const openrouterBadge = keyBadge(false, "OpenRouter");
  const omnirouteBadge = keyBadge(false, "OmniRoute");

  const onlineStatusCard = h(
    "div",
    { class: "provider-status-card" },
    h("div", { style: "font:600 12px var(--font);color:var(--ink)" }, h("span", { text: "Online provider key status" })),
    h("div", { style: "display:flex;flex-wrap:wrap;gap:6px" }, openaiBadge, openrouterBadge, omnirouteBadge),
  );

  // ── Refresh all provider status ─────────────────────────────────────────
  function updateBadge(badge: HTMLElement, present: boolean, name: string) {
    badge.textContent = present ? `${name}: present ✓` : `${name}: missing ✗`;
    badge.style.color = present ? "#86efac" : "#ff8d97";
    badge.style.background = present ? "rgba(34,197,94,0.1)" : "rgba(244,80,94,0.1)";
  }

  async function refreshAllStatus() {
    try {
      const s = await Bridge.providerStatus();
      // Ollama
      const isActive = s.ollama.startsWith("Active");
      ollamaActiveDot.style.background = isActive ? "#22c55e" : "#f4505e";
      const selectedKeyPresent = settings.provider === "ollama"
        || (settings.provider === "openrouter" ? s.openrouterKey
          : settings.provider === "omniroute" ? s.omnirouteKey : s.openaiKey);
      dot.style.background = selectedKeyPresent ? "#22c55e" : "#f4505e";
      ollamaActiveLabel.textContent = s.ollama;
      ollamaActiveLabel.style.color = "";
      ollamaEndpoint.textContent = settings.ollamaUrl || "http://127.0.0.1:11434";
      ollamaSelectedModel.textContent = settings.ollamaModel;
      detectedOllamaModels = s.ollamaModels;
      updateModelOptions();
      const countMatch = s.ollama.match(/(\d+)\s*model/);
      ollamaModelCount.textContent = countMatch ? countMatch[1] : "—";
      updateBadge(openaiBadge, s.openaiKey, "OpenAI-compatible");
      updateBadge(openrouterBadge, s.openrouterKey, "OpenRouter");
      updateBadge(omnirouteBadge, s.omnirouteKey, "OmniRoute");
    } catch (err) {
      ollamaActiveDot.style.background = "#f4505e";
      ollamaActiveLabel.textContent = `Status unavailable: ${String(err).replace(/^Error:\s*/, "")}`;
      ollamaModelCount.textContent = "—";
    }
  }

  const refreshAllBtn = h("button", { class: "secondary", text: "↻ Refresh status" });
  refreshAllBtn.addEventListener("click", async () => {
    refreshAllBtn.disabled = true;
    refreshAllBtn.textContent = "Refreshing…";
    try {
      await save();
      await refreshAllStatus();
    } finally {
      refreshAllBtn.disabled = false;
      refreshAllBtn.textContent = "↻ Refresh status";
    }
  });

  // ── API key field ───────────────────────────────────────────────────────
  const field = h("input", {
    type: "password",
    placeholder: "OpenRouter API key",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  // ── Provider tabs ───────────────────────────────────────────────────────
  const provider = h("select", {}) as HTMLSelectElement;
  provider.append(
    h("option", { value: "online", text: "OpenAI-compatible online" }),
    h("option", { value: "openrouter", text: "OpenRouter" }),
    h("option", { value: "omniroute", text: "OmniRoute" }),
    h("option", { value: "ollama", text: "Ollama local" }),
  );
  provider.value = settings.provider;
  const endpointValue = () => settings.provider === "ollama"
    ? settings.ollamaUrl
    : settings.provider === "openrouter" ? settings.openrouterBaseUrl
      : settings.provider === "omniroute" ? settings.omnirouteBaseUrl : settings.onlineBaseUrl;
  const providerTabs = h("div", { class: "row" }, h("label", { text: "Provider" }));
  const tabButtons: HTMLButtonElement[] = [];
  for (const [value, label] of [
    ["online", "OpenAI-compatible"],
    ["openrouter", "OpenRouter"],
    ["omniroute", "OmniRoute"],
    ["ollama", "Ollama"],
  ] as const) {
    const tab = h("button", {
      class: "secondary",
      text: label,
      "data-provider": value,
      "aria-pressed": settings.provider === value,
    }) as HTMLButtonElement;
    tab.addEventListener("click", () => {
      provider.value = value;
      provider.dispatchEvent(new Event("change"));
    });
    tabButtons.push(tab);
    providerTabs.append(tab);
  }
  const endpoint = h("input", {
    value: endpointValue(),
    placeholder: settings.provider === "ollama" ? "http://127.0.0.1:11434"
      : settings.provider === "openrouter" ? "https://openrouter.ai/api/v1"
        : settings.provider === "omniroute" ? "http://localhost:20128/v1" : "https://api.openai.com/v1",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const modelOptions = h("datalist", { id: "provider-model-options" });
  const model = h("input", {
    type: "text",
    list: "provider-model-options",
    value: settings.model,
    placeholder: "Enter a model name",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;

  const selectedModel = () => settings.provider === "ollama"
    ? settings.ollamaModel
    : settings.provider === "omniroute" ? settings.omnirouteModel
      : settings.provider === "openrouter" ? settings.openrouterModel : settings.model;

  function updateModelOptions() {
    clear(modelOptions);
    const suggestions = settings.provider === "ollama"
      ? [...detectedOllamaModels]
      : settings.provider === "openrouter" ? MODELS.map(([id]) => id) : [];
    const current = selectedModel();
    if (current && !suggestions.includes(current)) suggestions.unshift(current);
    for (const name of suggestions) modelOptions.append(h("option", { value: name }));
    model.value = current;
    ollamaSelectedModel.textContent = settings.ollamaModel;
  }
  updateModelOptions();
  const keyName = () => settings.provider === "openrouter" ? "openrouter-api-key"
    : settings.provider === "omniroute" ? "omniroute-api-key" : "online-api-key";

  async function refresh() {
    const present = settings.provider === "ollama" || ((await Bridge.secretPresent(keyName())) ?? false);
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = settings.provider === "ollama"
      ? "Ollama does not require an API key."
      : present
        ? "Key saved in the Windows Credential Manager."
        : "No key yet — the chat needs one.";
    state.style.color = "";
    field.placeholder = settings.provider === "ollama" ? "No key required" : present ? "••••••••••••  (stored)" : "API key";
    clearBtn.style.display = settings.provider !== "ollama" && present ? "" : "none";
    tabButtons.forEach((tab) => {
      const value = tab.dataset.provider;
      tab.classList.toggle("primary", value === settings.provider);
      tab.setAttribute("aria-pressed", String(value === settings.provider));
    });
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet(keyName(), value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
      await refreshAllStatus();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear(keyName());
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
      await refreshAllStatus();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  model.addEventListener("change", () => {
    const value = model.value.trim();
    if (!value) {
      model.value = selectedModel();
      return;
    }
    if (settings.provider === "ollama") settings.ollamaModel = value;
    else if (settings.provider === "omniroute") settings.omnirouteModel = value;
    else if (settings.provider === "openrouter") settings.openrouterModel = value;
    else settings.model = value;
    settings.model = value;
    ollamaSelectedModel.textContent = settings.ollamaModel;
    updateModelOptions();
    void save();
  });
  model.addEventListener("input", () => {
    if (settings.provider === "ollama") ollamaSelectedModel.textContent = model.value;
  });
  provider.addEventListener("change", async () => {
    settings.provider = provider.value as Settings["provider"];
    settings.model = selectedModel();
    endpoint.value = endpointValue();
    endpoint.placeholder = settings.provider === "ollama"
      ? "http://127.0.0.1:11434"
      : settings.provider === "openrouter" ? "https://openrouter.ai/api/v1"
        : settings.provider === "omniroute" ? "http://localhost:20128/v1" : "https://api.openai.com/v1";
    field.style.display = settings.provider === "ollama" ? "none" : "";
    saveBtn.style.display = settings.provider === "ollama" ? "none" : "";
    clearBtn.style.display = settings.provider === "ollama" ? "none" : "";
    updateModelOptions();
    await save();
    await refresh();
    await refreshAllStatus();
  });
  endpoint.addEventListener("change", async () => {
    if (settings.provider === "ollama") settings.ollamaUrl = endpoint.value.trim();
    else if (settings.provider === "openrouter") settings.openrouterBaseUrl = endpoint.value.trim();
    else if (settings.provider === "omniroute") settings.omnirouteBaseUrl = endpoint.value.trim();
    else settings.onlineBaseUrl = endpoint.value.trim();
    if (settings.provider === "ollama") ollamaEndpoint.textContent = settings.ollamaUrl;
    await save();
  });
  field.style.display = settings.provider === "ollama" ? "none" : "";
  saveBtn.style.display = settings.provider === "ollama" ? "none" : "";

  const testBtn = h("button", { class: "secondary", text: "Test connection" });
  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    testBtn.textContent = "Testing…";
    try {
      await save();
      state.textContent = await Bridge.testProvider(settings.provider);
      state.style.color = "#22c55e";
    } catch (error) {
      state.textContent = String(error).replace(/^Error:\s*/, "");
      state.style.color = "#f4505e";
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test connection";
    }
  });

  // Kick off initial status fetch
  void refresh();
  void refreshAllStatus();

  // ── Open full settings window ───────────────────────────────────────────
  const openSettingsBtn = h("button", { class: "secondary", text: "⚙ Open Settings" });
  openSettingsBtn.addEventListener("click", async () => {
    openSettingsBtn.disabled = true;
    try {
      await Bridge.openSettingsWindow();
    } catch (err) {
      clear(feedback);
      feedback.append(h("div", { class: "notice err", text: `Could not open settings: ${String(err)}` }));
    } finally {
      openSettingsBtn.disabled = false;
    }
  });

  return h(
    "section",
    { class: "settings-section provider-section" },
    h("h2", {}, dot, h("span", { text: "AI provider" })),
    h("div", { class: "row" }, refreshAllBtn, openSettingsBtn),
    ollamaCard,
    onlineStatusCard,
    providerTabs,
    h("div", { class: "row" }, provider),
    h("div", { class: "row" }, h("label", { text: "Endpoint" }), endpoint),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn, testBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    modelOptions,
    feedback,
  );
}

function compareVersions(left: string, right: string): number {
  const parts = (version: string) => version.replace(/^v/i, "").split("-")[0].split(".").map((part) => Number(part) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function updaterSection(): HTMLElement {
  const result = h("div", { class: "hint", text: "Check GitHub Releases for a newer ACT 3 version." });
  const check = h("button", { class: "secondary", text: "Check for updates" });
  const release = h("button", { class: "primary", text: "Open GitHub release", style: "display:none" });
  let releaseUrl = "";

  check.addEventListener("click", async () => {
    check.disabled = true;
    check.textContent = "Checking…";
    release.style.display = "none";
    try {
      const update: UpdateStatus = await Bridge.checkForUpdate();
      if (compareVersions(update.latestVersion, update.currentVersion) > 0) {
        result.textContent = `ACT 3 ${update.latestVersion} is available (you have ${update.currentVersion}).`;
        result.className = "notice warn";
        releaseUrl = update.releaseUrl;
        release.style.display = "";
      } else {
        result.textContent = `You’re up to date (version ${update.currentVersion}).`;
        result.className = "notice ok";
      }
    } catch (error) {
      result.textContent = `Update check failed: ${String(error).replace(/^Error:\s*/, "")}`;
      result.className = "notice err";
    } finally {
      check.disabled = false;
      check.textContent = "Check for updates";
    }
  });
  release.addEventListener("click", () => {
    if (releaseUrl) void Bridge.openUrl(releaseUrl);
  });

  return h("section", {},
    h("h2", {}, h("span", { text: "Updates" })),
    result,
    h("div", { class: "row" }, check, release),
    h("div", { class: "hint", text: "Updates open the matching GitHub Release so you can download and run its installer." }),
  );
}


// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to ACT 3 — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  const friendSchedule = h("div", { class: "row" });
  const friendQuietHours = h("div", { class: "row" });
  const friendStatus = h("span", { class: "hint", text: settings.friendModeEnabled ? "on" : "off" });
  const updateFriendControls = () => {
    for (const control of [friendMin, friendMax, quietStart, quietEnd]) {
      control.disabled = !settings.friendModeEnabled;
    }
    friendSchedule.style.opacity = settings.friendModeEnabled ? "1" : "0.45";
    friendQuietHours.style.opacity = settings.friendModeEnabled ? "1" : "0.45";
  };
  const friendMin = h("input", {
    type: "number", min: "15", max: "1440", step: "15",
    value: String(settings.friendModeMinMinutes), style: "width:76px",
  }) as HTMLInputElement;
  const friendMax = h("input", {
    type: "number", min: "15", max: "1440", step: "15",
    value: String(settings.friendModeMaxMinutes), style: "width:76px",
  }) as HTMLInputElement;
  const quietStart = h("input", {
    type: "number", min: "0", max: "23", step: "1",
    value: String(settings.friendModeQuietStartHour), style: "width:64px",
  }) as HTMLInputElement;
  const quietEnd = h("input", {
    type: "number", min: "0", max: "23", step: "1",
    value: String(settings.friendModeQuietEndHour), style: "width:64px",
  }) as HTMLInputElement;
  friendSchedule.append(
    h("label", { text: "Random hello every" }),
    friendMin,
    h("span", { class: "hint", text: "to" }),
    friendMax,
    h("span", { class: "hint", text: "minutes" }),
  );
  friendQuietHours.append(
    h("label", { text: "Quiet hours" }),
    quietStart,
    h("span", { class: "hint", text: "to" }),
    quietEnd,
    h("span", { class: "hint", text: "(local time)" }),
  );
  const updateFriendRange = () => {
    const min = Math.max(15, Math.min(1440, Number(friendMin.value) || 30));
    const max = Math.max(min, Math.min(1440, Number(friendMax.value) || 90));
    settings.friendModeMinMinutes = min;
    settings.friendModeMaxMinutes = max;
    friendMin.value = String(min);
    friendMax.value = String(max);
    void save();
  };
  friendMin.addEventListener("change", updateFriendRange);
  friendMax.addEventListener("change", updateFriendRange);
  const updateQuietHours = () => {
    settings.friendModeQuietStartHour = Math.max(0, Math.min(23, Number(quietStart.value) || 0));
    settings.friendModeQuietEndHour = Math.max(0, Math.min(23, Number(quietEnd.value) || 0));
    quietStart.value = String(settings.friendModeQuietStartHour);
    quietEnd.value = String(settings.friendModeQuietEndHour);
    void save();
  };
  quietStart.addEventListener("change", updateQuietHours);
  quietEnd.addEventListener("change", updateQuietHours);

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
    h("h3", { text: "AI friend mode" }),
    h("div", { class: "hint", text: "ACT 3 can occasionally ask your chosen model for a short hello and show only its reply in chat. It waits until you have been away from your computer for 5 minutes, keeps the prompt private, and only opens the chat when the island is hidden." }),
    h("div", { class: "row" },
      h("label", { text: "Random hellos" }),
      toggle(settings.friendModeEnabled, (enabled) => {
        settings.friendModeEnabled = enabled;
        friendStatus.textContent = enabled ? "on" : "off";
        updateFriendControls();
        void save();
      }),
      friendStatus,
    ),
    friendSchedule,
    friendQuietHours,
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const keys = [
    "stripe-api-key", "github-token", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("header", { class: "settings-brand" },
      h("div", { class: "settings-brand-mark", "aria-hidden": "true" }, "3"),
      h("div", {},
        h("h1", {}, h("span", { text: "ACT 3" }), h("span", { class: "version", text: version })),
        h("p", { class: "settings-subtitle", text: "Companion settings · Private by design" }),
      ),
    ),
    claudeSection(status),
    apiSection(),
    mcpSection(),
    updaterSection(),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. The update checker contacts GitHub only when requested; chat and integrations contact the services you configure.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
