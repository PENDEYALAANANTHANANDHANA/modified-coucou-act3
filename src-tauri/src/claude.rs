// AI provider client for Ollama and OpenAI-compatible services. API keys stay
// in the Credential Manager and never cross the IPC boundary.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets;
use crate::settings::Settings;

pub const DEFAULT_MODEL: &str = "openrouter/auto";
pub const DEFAULT_OPENROUTER_URL: &str = "https://openrouter.ai/api/v1";

#[derive(Default)]
pub struct Chat;

impl Chat {
    pub fn reset(&self) {}
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
}

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view.
pub async fn send(
    _chat: &Chat,
    settings: &Settings,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    match settings.provider.as_str() {
        "ollama" => send_ollama(settings, query, context).await,
        "online" | "openrouter" => send_online(settings, query, context).await,
        _ => Err("Unsupported AI provider. Choose OpenAI-compatible, OpenRouter, or Ollama.".into()),
    }
}

async fn send_ollama(settings: &Settings, query: String, context: Option<ChatContext>) -> Result<ChatReply, String> {
    let prompt = contextual_prompt(query, context);
    let response = reqwest::Client::new()
        .post(format!("{}/api/chat", settings.ollama_url.trim_end_matches('/')))
        .json(&json!({"model": settings.model, "messages": [{"role": "user", "content": prompt}], "stream": false}))
        .send().await.map_err(|e| format!("Ollama connection failed: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|e| format!("Invalid Ollama response: {e}"))?;
    if !status.is_success() { return Err(format!("Ollama {status}")); }
    let text = body["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() { return Err("Ollama returned no text.".into()); }
    Ok(ChatReply { text })
}

async fn send_online(settings: &Settings, query: String, context: Option<ChatContext>) -> Result<ChatReply, String> {
    let key_name = if settings.provider == "openrouter" { "openrouter-api-key" } else { "online-api-key" };
    let key = secrets::get(key_name).ok_or_else(|| "Online provider key missing. Open settings.".to_string())?;
    let prompt = contextual_prompt(query, context);
    let response = reqwest::Client::new()
        .post(format!("{}/chat/completions", online_base_url(settings).trim_end_matches('/')))
        .bearer_auth(key)
        .json(&json!({"model": settings.model, "messages": [{"role": "user", "content": prompt}]}))
        .send().await.map_err(|e| format!("Online provider connection failed: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|e| format!("Invalid online provider response: {e}"))?;
    if !status.is_success() { return Err(format!("Online provider {status}")); }
    let text = body["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() { return Err("Online provider returned no text.".into()); }
    Ok(ChatReply { text })
}

fn contextual_prompt(query: String, context: Option<ChatContext>) -> String {
    match context {
        Some(ChatContext::File { name, path }) => {
            format!("File: {name}\n{}\n\n{query}", std::fs::read_to_string(path).unwrap_or_default())
        }
        Some(ChatContext::Window { app_name, title, url }) => {
            let mut description = format!("Context — App: {app_name}, Window: {title}");
            if let Some(url) = url {
                description.push_str(&format!(", URL: {url}"));
            }
            format!("{description}\n\n{query}")
        }
        None => query,
    }
}

fn online_base_url(settings: &Settings) -> &str {
    if settings.provider == "openrouter" {
        &settings.openrouter_base_url
    } else {
        &settings.online_base_url
    }
}

pub async fn test_provider(settings: &Settings) -> Result<String, String> {
    match settings.provider.as_str() {
        "ollama" => {
            let models = ollama_models(settings).await?;
            let selected = models.iter().any(|name| name == &settings.model);
            return Ok(format!("Ollama reachable · {} models · {}selected", models.len(), if selected { "" } else { "model not " }));
        }
        "openrouter" | "online" => {
            let key_name = if settings.provider == "openrouter" { "openrouter-api-key" } else { "online-api-key" };
            let key = secrets::get(key_name).ok_or_else(|| "Provider API key is not set.".to_string())?;
            let response = reqwest::Client::new()
                .get(format!("{}/models", online_base_url(settings).trim_end_matches('/')))
                .bearer_auth(key)
                .send()
                .await
                .map_err(|e| format!("Provider unreachable: {e}"))?;
            if response.status().is_success() { Ok("Provider reachable · API key accepted.".into()) } else { Err(format!("Provider returned {}", response.status())) }
        }
        _ => Err("Unknown provider.".into()),
    }
}

pub async fn ollama_models(settings: &Settings) -> Result<Vec<String>, String> {
    let response = reqwest::Client::new()
        .get(format!("{}/api/tags", settings.ollama_url.trim_end_matches('/')))
        .send().await.map_err(|e| format!("Ollama unreachable: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Ollama returned HTTP {}", response.status()));
    }
    let body: Value = response.json().await.map_err(|e| format!("Invalid Ollama response: {e}"))?;
    let models = body["models"]
        .as_array()
        .ok_or_else(|| "Invalid Ollama response: models list is missing.".to_string())?;
    Ok(models
        .iter()
        .filter_map(|model| model["name"].as_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect())
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
