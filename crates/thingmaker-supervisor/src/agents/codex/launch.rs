//! Launch contract for `codex app-server`.
//!
//! The program is the official `codex` binary — on PATH, in a global npm
//! prefix, or the one the ChatGPT app ships — run as `codex app-server` on
//! stdio. Everything about a session is said over the protocol: the working
//! directory, sandbox and approval policy on `thread/start`, the model and
//! effort on each `turn/start`.
//!
//! `codex_home` selects the account: Codex keeps its sign-in under
//! `$CODEX_HOME` (default `~/.codex`), so a second directory is a second
//! account, switched without touching the first one's credentials.

use std::path::PathBuf;

use serde_json::{Value, json};

use crate::{acp::launch::SessionId, agents::PermissionStance};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexLaunchOptions {
    /// Canonical workspace root; also the child's working directory and the
    /// thread's `cwd`.
    pub root: PathBuf,
    /// The `codex` binary.
    pub program: PathBuf,
    /// The id the desktop addresses this attachment by until Codex answers
    /// with its thread id (see `AgentLaunch::session_id`).
    pub reserved: SessionId,
    /// The model to run, by Codex's own id (`gpt-6-astra`, …). `None` leaves
    /// the account default.
    pub model: Option<String>,
    /// The reasoning effort, by Codex's own id (`low` … `max`).
    pub effort: Option<String>,
    /// The thread to resume, from a previous run.
    pub resume: Option<String>,
    pub permission_mode: PermissionStance,
    /// `$CODEX_HOME` for this session, when it is not the default account.
    pub codex_home: Option<PathBuf>,
    /// Route this sandboxed app-server to the local Ollama Responses API.
    pub local: bool,
    /// Developer instructions for the thread: an orchestrator's briefing on
    /// its team.
    pub developer_instructions: Option<String>,
    /// Config overrides for the thread (`features.multi_agent`, …), beside
    /// the session's MCP servers. The user's `config.toml` is not touched.
    pub config: serde_json::Map<String, Value>,
    pub resources: Option<CodexResources>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CodexResources {
    pub skills: Vec<PathBuf>,
    pub mcps: std::collections::BTreeMap<String, Value>,
}

impl CodexLaunchOptions {
    pub fn new(root: impl Into<PathBuf>, program: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            program: program.into(),
            reserved: SessionId::reserve(),
            model: None,
            effort: None,
            resume: None,
            permission_mode: PermissionStance::ReadOnly,
            local: false,
            codex_home: None,
            developer_instructions: None,
            config: serde_json::Map::new(),
            resources: None,
        }
    }

    pub fn arguments(&self) -> Vec<String> {
        if self.local {
            return vec!["-c".into(), "model_provider=\"thingmaker_local\"".into(),
                "-c".into(), "model_providers.thingmaker_local.name=\"Ollama\"".into(),
                "-c".into(), "model_providers.thingmaker_local.wire_api=\"responses\"".into(),
                "-c".into(), format!("model_providers.thingmaker_local.base_url={}", json!(format!("{}/v1", crate::agents::local::ollama::address().trim_end_matches('/')))),
                "-c".into(), "web_search=\"disabled\"".into(),
                "-c".into(), "project_doc_max_bytes=0".into(),
                "-c".into(), "analytics.enabled=false".into(), "app-server".into()];
        }
        vec!["app-server".into()]
    }
}

/// Codex's sandbox for a stance. A trusted workspace may be written; an
/// inspected one may only be read. The user's own `config.toml` may say
/// `danger-full-access`, and a session the desktop starts does not inherit
/// that: the workspace's trust decides, as it does for every provider.
pub fn sandbox_mode(stance: PermissionStance) -> &'static str {
    match stance {
        PermissionStance::AcceptEdits => "workspace-write",
        PermissionStance::ReadOnly => "read-only",
    }
}

/// The override that turns Codex's own multi-agent tools off, for an
/// orchestrator whose workers the combo chooses.
pub const MULTI_AGENT_FEATURE: &str = "features.multi_agent";

/// Codex's approval policy for a stance: `on-request`, so anything beyond the
/// sandbox is asked for — and answered by the stance, on the event stream,
/// rather than silently granted by a `never` policy.
pub fn approval_policy(_stance: PermissionStance) -> &'static str {
    "on-request"
}

/// The `initialize` params Codex's app-server takes.
pub fn initialize_params(name: &str, title: &str, version: &str) -> Value {
    json!({
        "clientInfo": { "name": name, "title": title, "version": version },
        "capabilities": { "experimentalApi": true, "requestAttestation": false }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_codex_disables_provider_hosted_search() {
        let mut options = CodexLaunchOptions::new("/work", "codex");
        options.local = true;
        options.codex_home = Some(PathBuf::from("isolated").join("local-models/codex"));
        let args = options.arguments();
        assert!(args.contains(&"project_doc_max_bytes=0".to_owned()));
        assert!(args.contains(&"model_providers.thingmaker_local.wire_api=\"responses\"".to_owned()));
        let env = crate::agents::AgentLaunch::Codex(options.clone()).environment();
        assert!(env.contains(&("CODEX_HOME".into(), options.codex_home.as_ref().unwrap().to_string_lossy().into_owned())));
        assert!(options.arguments().windows(2).any(|pair| pair == ["-c", "web_search=\"disabled\""]));
    }

    #[test]
    fn the_workspaces_trust_decides_the_sandbox_not_the_users_config() {
        assert_eq!(sandbox_mode(PermissionStance::AcceptEdits), "workspace-write");
        assert_eq!(sandbox_mode(PermissionStance::ReadOnly), "read-only");
        assert_eq!(approval_policy(PermissionStance::AcceptEdits), "on-request");
        let options = CodexLaunchOptions::new("/work", "/usr/local/bin/codex");
        assert_eq!(options.arguments(), ["app-server"]);
        assert_eq!(options.permission_mode, PermissionStance::ReadOnly, "the safe stance is the default");
    }
}
