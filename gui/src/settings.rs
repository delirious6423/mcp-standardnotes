//! Copy only a new MCP registration, never an existing client configuration.
use serde_json::{Value, json};

pub(crate) fn mcp_settings_snippet(entry: &Value) -> Option<String> {
    let entry = entry.as_object()?;
    // Only registration metadata from our helper is eligible for an explicit clipboard action.
    if entry
        .keys()
        .any(|key| !matches!(key.as_str(), "command" | "args" | "env"))
        || entry.get("command")?.as_str()?.is_empty()
        || !entry.get("args")?.as_array()?.iter().all(Value::is_string)
        || !entry.get("env")?.as_object()?.iter().all(|(key, value)| {
            matches!(key.as_str(), "SN_STATE_DIR" | "SN_EMAIL" | "SN_GUI_PATH") && value.is_string()
        })
    {
        return None;
    }
    serde_json::to_string_pretty(&json!({"mcpServers":{"standardnotes":entry}})).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_contains_only_registration_and_rejects_secret_fields() {
        let response = json!({"unrelated":{"token":"synthetic-secret"}, "manual":[{"client":"Test","configPath":"/synthetic/config", "entry":{"command":"node","args":["/synthetic/dist/index.js"],"env":{"SN_EMAIL":"b@example.invalid","SN_GUI_PATH":"/synthetic/app"}}}]});
        let snippet = mcp_settings_snippet(&response["manual"][0]["entry"])
            .expect("registration metadata is safe");
        let parsed: Value = serde_json::from_str(&snippet).expect("snippet is JSON");
        assert_eq!(
            parsed["mcpServers"]["standardnotes"],
            response["manual"][0]["entry"]
        );
        assert!(!snippet.contains("synthetic-secret"));
        assert!(!snippet.contains("configPath"));
        let mut poisoned = response["manual"][0]["entry"].clone();
        poisoned["env"]["SN_PASSWORD"] = json!("synthetic-secret");
        assert!(mcp_settings_snippet(&poisoned).is_none());
        assert!(mcp_settings_snippet(&json!({"preview":"note text"})).is_none());
    }
}
