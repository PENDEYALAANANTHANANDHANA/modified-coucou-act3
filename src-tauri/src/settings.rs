// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    #[serde(default)]
    pub friend_mode_enabled: bool,
    #[serde(default = "default_friend_mode_min_minutes")]
    pub friend_mode_min_minutes: u32,
    #[serde(default = "default_friend_mode_max_minutes")]
    pub friend_mode_max_minutes: u32,
    #[serde(default = "default_friend_mode_quiet_start_hour")]
    pub friend_mode_quiet_start_hour: u32,
    #[serde(default = "default_friend_mode_quiet_end_hour")]
    pub friend_mode_quiet_end_hour: u32,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Selected model used by the active provider. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_online_base_url")]
    pub online_base_url: String,
    #[serde(default = "default_openrouter_base_url")]
    pub openrouter_base_url: String,
    #[serde(default = "default_omniroute_base_url")]
    pub omniroute_base_url: String,
    #[serde(default = "default_ollama_url")]
    pub ollama_url: String,
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

fn default_friend_mode_min_minutes() -> u32 { 30 }
fn default_friend_mode_max_minutes() -> u32 { 90 }
fn default_friend_mode_quiet_start_hour() -> u32 { 22 }
fn default_friend_mode_quiet_end_hour() -> u32 { 8 }
fn default_provider() -> String { "openrouter".into() }
fn default_online_base_url() -> String { "https://api.openai.com/v1".into() }
fn default_openrouter_base_url() -> String { crate::claude::DEFAULT_OPENROUTER_URL.to_string() }
fn default_omniroute_base_url() -> String { "http://localhost:20128/v1".into() }
fn default_ollama_url() -> String { "http://127.0.0.1:11434".into() }

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            friend_mode_enabled: false,
            friend_mode_min_minutes: default_friend_mode_min_minutes(),
            friend_mode_max_minutes: default_friend_mode_max_minutes(),
            friend_mode_quiet_start_hour: default_friend_mode_quiet_start_hour(),
            friend_mode_quiet_end_hour: default_friend_mode_quiet_end_hour(),
            active_integrations: vec!["integration_resend".into(), "integration_github".into()],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            provider: default_provider(),
            online_base_url: default_online_base_url(),
            openrouter_base_url: default_openrouter_base_url(),
            omniroute_base_url: default_omniroute_base_url(),
            ollama_url: default_ollama_url(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => {
            let mut settings: Settings = serde_json::from_slice(&bytes).unwrap_or_default();
            normalize_friend_mode(&mut settings);
            if !matches!(settings.provider.as_str(), "online" | "openrouter" | "omniroute" | "ollama") {
                settings.provider = default_provider();
            }
            if settings.model.starts_with("claude-") {
                settings.model = if settings.provider == "ollama" {
                    "llama3.2".into()
                } else {
                    default_model()
                };
            }
            settings.active_integrations.retain(|id| id != "integration_n8n" && id != "integration_vercel");
            settings
        }
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let mut clean = settings.clone();
    normalize_friend_mode(&mut clean);
    clean.active_integrations.retain(|id| id != "integration_n8n" && id != "integration_vercel");
    let json = serde_json::to_vec_pretty(&clean)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}

fn normalize_friend_mode(settings: &mut Settings) {
    settings.friend_mode_min_minutes = settings.friend_mode_min_minutes.clamp(15, 1440);
    settings.friend_mode_max_minutes = settings.friend_mode_max_minutes.clamp(
        settings.friend_mode_min_minutes,
        1440,
    );
    settings.friend_mode_quiet_start_hour %= 24;
    settings.friend_mode_quiet_end_hour %= 24;
}

#[cfg(test)]
mod tests {
    use super::{normalize_friend_mode, Settings};

    #[test]
    fn older_settings_receive_safe_friend_mode_defaults() {
        let mut saved = serde_json::to_value(Settings::default()).unwrap();
        let object = saved.as_object_mut().unwrap();
        object.remove("friendModeEnabled");
        object.remove("friendModeMinMinutes");
        object.remove("friendModeMaxMinutes");
        object.remove("friendModeQuietStartHour");
        object.remove("friendModeQuietEndHour");
        object.remove("omnirouteBaseUrl");

        let loaded: Settings = serde_json::from_value(saved).unwrap();
        assert!(!loaded.friend_mode_enabled);
        assert_eq!(loaded.friend_mode_min_minutes, 30);
        assert_eq!(loaded.friend_mode_max_minutes, 90);
        assert_eq!(loaded.friend_mode_quiet_start_hour, 22);
        assert_eq!(loaded.friend_mode_quiet_end_hour, 8);
        assert_eq!(loaded.omniroute_base_url, "http://localhost:20128/v1");
    }

    #[test]
    fn friend_mode_settings_are_bounded() {
        let mut settings = Settings::default();
        settings.friend_mode_min_minutes = 0;
        settings.friend_mode_max_minutes = 1;
        settings.friend_mode_quiet_start_hour = 24;
        settings.friend_mode_quiet_end_hour = 25;

        normalize_friend_mode(&mut settings);

        assert_eq!(settings.friend_mode_min_minutes, 15);
        assert_eq!(settings.friend_mode_max_minutes, 15);
        assert_eq!(settings.friend_mode_quiet_start_hour, 0);
        assert_eq!(settings.friend_mode_quiet_end_hour, 1);
    }
}
