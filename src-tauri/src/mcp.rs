use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;
use crate::settings::McpServerConfig;

const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MESSAGE_BYTES: usize = 1_048_576;
const MAX_RESULT_BYTES: usize = 200_000;
const PROTOCOL_VERSION: &str = "2025-03-26";
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
static APPROVAL_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct PendingApprovals(pub Mutex<HashMap<String, oneshot::Sender<bool>>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpApprovalRequest {
    pub request_id: String,
    pub server_id: String,
    pub server_name: String,
    pub tool_name: String,
    pub description: String,
    pub arguments: Value,
}

pub async fn request_approval(
    app: &AppHandle,
    pending: &PendingApprovals,
    server_id: String,
    server_name: String,
    tool_name: String,
    description: String,
    arguments: Value,
) -> Result<bool, String> {
    let request_id = format!(
        "mcp-{}-{}",
        std::process::id(),
        APPROVAL_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = oneshot::channel();
    pending
        .0
        .lock()
        .map_err(|_| "MCP approval state is unavailable.".to_string())?
        .insert(request_id.clone(), sender);
    let request = McpApprovalRequest {
        request_id: request_id.clone(),
        server_id,
        server_name,
        tool_name,
        description,
        arguments,
    };
    if let Err(error) = app.emit_to(WINDOW_LABEL, "mcp-approval", request) {
        pending.0.lock().unwrap().remove(&request_id);
        return Err(format!("Could not show MCP tool approval in ACT 3: {error}"));
    }
    let result = timeout(APPROVAL_TIMEOUT, receiver)
        .await
        .map_err(|_| "MCP approval timed out; tool was not run.".to_string())?
        .map_err(|_| "MCP approval was cancelled; tool was not run.".to_string());
    pending.0.lock().unwrap().remove(&request_id);
    result
}

pub fn decide(pending: &PendingApprovals, request_id: &str, allow: bool) -> Result<(), String> {
    let sender = pending
        .0
        .lock()
        .map_err(|_| "MCP approval state is unavailable.".to_string())?
        .remove(request_id)
        .ok_or_else(|| "This MCP approval is no longer pending.".to_string())?;
    sender
        .send(allow)
        .map_err(|_| "The MCP chat request was cancelled before approval arrived.".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub server_id: String,
    pub server_name: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Session {
    async fn start(server: &McpServerConfig) -> Result<Self, String> {
        validate_server(server)?;
        let mut command = Command::new(&server.command);
        command
            .env_clear()
            .args(&server.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for key in [
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "USERNAME",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        crate::platform::no_console(command.as_std_mut());
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Could not start MCP server '{}': {error}",
                server.name
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP server stdin was not available.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP server stdout was not available.".to_string())?;
        let mut session = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        };
        session
            .request(
                1,
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "ACT 3", "version": env!("CARGO_PKG_VERSION")}
                }),
            )
            .await?;
        session.notification("notifications/initialized", json!({})).await?;
        Ok(session)
    }

    async fn notification(&mut self, method: &str, params: Value) -> Result<(), String> {
        let mut message = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .map_err(|error| format!("Could not encode MCP notification: {error}"))?;
        message.push(b'\n');
        self.stdin
            .write_all(&message)
            .await
            .map_err(|error| format!("Could not write to MCP server: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush MCP server request: {error}"))
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        let mut message = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .map_err(|error| format!("Could not encode MCP request: {error}"))?;
        if message.len() > MAX_MESSAGE_BYTES {
            return Err("MCP request exceeds the 1 MB limit.".into());
        }
        message.push(b'\n');
        self.stdin
            .write_all(&message)
            .await
            .map_err(|error| format!("Could not write to MCP server: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush MCP server request: {error}"))?;

        timeout(RPC_TIMEOUT, async {
            loop {
                let mut line = String::new();
                let read = self
                    .stdout
                    .read_line(&mut line)
                    .await
                    .map_err(|error| format!("Could not read from MCP server: {error}"))?;
                if read == 0 {
                    return Err("MCP server closed its output before replying.".into());
                }
                if line.len() > MAX_MESSAGE_BYTES {
                    return Err("MCP server response exceeds the 1 MB limit.".into());
                }
                let response: Value = serde_json::from_str(&line)
                    .map_err(|error| format!("MCP server returned invalid JSON-RPC: {error}"))?;
                if response["id"].as_u64() != Some(id) {
                    continue;
                }
                if let Some(error) = response.get("error") {
                    return Err(format!("MCP {method} failed: {error}"));
                }
                return response
                    .get("result")
                    .cloned()
                    .ok_or_else(|| format!("MCP {method} response did not contain a result."));
            }
        })
        .await
        .map_err(|_| format!("MCP {method} timed out after {} seconds.", RPC_TIMEOUT.as_secs()))?
    }

    async fn list_tools(&mut self) -> Result<Vec<Value>, String> {
        let result = self.request(2, "tools/list", json!({})).await?;
        result["tools"]
            .as_array()
            .cloned()
            .ok_or_else(|| "MCP tools/list response did not contain a tools array.".into())
    }

    async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<String, String> {
        if serde_json::to_vec(&arguments)
            .map_err(|error| format!("Could not encode MCP arguments: {error}"))?
            .len()
            > 64 * 1024
        {
            return Err("MCP tool arguments exceed the 64 KB limit.".into());
        }
        let result = self
            .request(
                3,
                "tools/call",
                json!({"name": name, "arguments": arguments}),
            )
            .await?;
        if result["isError"].as_bool() == Some(true) {
            return Err(format!("MCP tool returned an error: {}", result));
        }
        let text = result["content"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| result.to_string());
        if text.len() > MAX_RESULT_BYTES {
            return Err("MCP tool result exceeds the 200 KB limit.".into());
        }
        Ok(text)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn validate_server(server: &McpServerConfig) -> Result<(), String> {
    if !server.enabled {
        return Err(format!("MCP server '{}' is disabled.", server.name));
    }
    if server.id.trim().is_empty() || server.name.trim().is_empty() {
        return Err("MCP server ID and name are required.".into());
    }
    if server.command.trim().is_empty() || server.command.len() > 4096 {
        return Err("Enter an MCP executable path or command, up to 4,096 characters.".into());
    }
    if server.args.len() > 64 || server.args.iter().any(|arg| arg.len() > 4096) {
        return Err("MCP server configuration supports up to 64 arguments of 4,096 characters each.".into());
    }
    if server.args.iter().map(String::len).sum::<usize>() > 32 * 1024 {
        return Err("Combined MCP server arguments exceed the 32 KB limit.".into());
    }
    Ok(())
}

fn parse_tools(server: &McpServerConfig, raw: Vec<Value>) -> Result<Vec<McpTool>, String> {
    if raw.len() > 128 {
        return Err("MCP server exposed more than 128 tools; this server was refused.".into());
    }
    raw.into_iter()
        .map(|tool| {
            let name = tool["name"]
                .as_str()
                .filter(|name| !name.is_empty() && name.len() <= 128)
                .ok_or_else(|| "MCP server exposed a tool with an invalid name.".to_string())?;
            let input_schema = tool
                .get("inputSchema")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
            Ok(McpTool {
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                name: name.to_string(),
                description: tool["description"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(4_000)
                    .collect(),
                input_schema,
            })
        })
        .collect()
}

pub async fn list_tools(server: &McpServerConfig) -> Result<Vec<McpTool>, String> {
    let mut session = Session::start(server).await?;
    parse_tools(server, session.list_tools().await?)
}

pub async fn call_tool(
    server: &McpServerConfig,
    tool_name: &str,
    arguments: Value,
) -> Result<String, String> {
    let mut session = Session::start(server).await?;
    let tools = parse_tools(server, session.list_tools().await?)?;
    if !tools.iter().any(|tool| tool.name == tool_name) {
        return Err(format!(
            "MCP server '{}' does not expose tool '{tool_name}'.",
            server.name
        ));
    }
    session.call_tool(tool_name, arguments).await
}

#[cfg(test)]
mod tests {
    use super::{parse_tools, validate_server};
    use crate::settings::McpServerConfig;
    use serde_json::json;

    fn server(enabled: bool) -> McpServerConfig {
        McpServerConfig {
            id: "server".into(),
            name: "Test server".into(),
            command: "mcp-server".into(),
            args: Vec::new(),
            enabled,
        }
    }

    #[test]
    fn disabled_server_is_never_started() {
        assert!(validate_server(&server(false))
            .unwrap_err()
            .contains("disabled"));
    }

    #[test]
    fn tool_descriptions_are_bounded_and_schemas_are_preserved() {
        let config = server(true);
        let tools = parse_tools(
            &config,
            vec![json!({
                "name": "create_note",
                "description": "x".repeat(5000),
                "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}}
            })],
        )
        .unwrap();
        assert_eq!(tools[0].description.len(), 4000);
        assert_eq!(
            tools[0].input_schema["properties"]["title"]["type"],
            "string"
        );
    }

    #[test]
    fn rejects_invalid_tool_names_and_too_many_tools() {
        let config = server(true);
        assert!(parse_tools(&config, vec![json!({"name": ""})]).is_err());
        assert!(parse_tools(&config, vec![json!({"name":"tool"}); 129]).is_err());
    }
}
