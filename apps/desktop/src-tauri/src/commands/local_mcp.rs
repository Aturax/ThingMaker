//! Make selected stdio servers reachable by a Windows AppContainer harness.
//! Each child still runs inside the same AppContainer. Credentials and config
//! travel through inherited pipes, and the actor owns the bridge lifetime.
use super::CommandResult;
use crate::state::AppState;
use serde_json::{Value, json};
use std::{process::Stdio, sync::Arc, time::Duration};
use thingmaker_supervisor::{DesktopError, agents::{AgentLaunch, Provider}, supervisor::SessionActorConfig};
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, process::Command};

pub async fn prepare(state: &AppState, config: &mut SessionActorConfig) -> CommandResult<()> {
    if config.launch.provider() != Provider::Local || matches!(&config.launch, AgentLaunch::Claude(o) if o.local.as_ref().is_some_and(|t| t.kind == thingmaker_supervisor::agents::local::LocalKind::Chat)) {
        return Ok(());
    }
    let workspace = config.launch.root().to_owned();
    let mut environment = config.environment.resolve(std::env::vars());
    // A sandboxed server needs its writable temp folder too.
    for (key, value) in config.launch.environment().into_iter().filter(|(key, _)| key == "TEMP" || key == "TMP") {
        environment.insert(key, value);
    }
    let optional = match &mut config.launch {
        AgentLaunch::Claude(o) => o.resources.as_mut().map(|(_, servers)| servers),
        AgentLaunch::Codex(o) => o.resources.as_mut().map(|resources| &mut resources.mcps),
        _ => None,
    };
    let mut servers: Vec<_> = optional.into_iter().flat_map(|servers| servers.values_mut())
        .map(|value| (value, false)).chain(config.mcp_servers.iter_mut().map(|value| (value, true)))
        .filter(|(value, _)| value["command"].is_string()).collect();
    if servers.is_empty() { return Ok(()) }
    let specs: Vec<_> = servers.iter().map(|(value, acp)| {
        let mut spec = (**value).clone();
        if *acp {
            let env: serde_json::Map<_, _> = spec["env"].as_array().into_iter().flatten()
                .filter_map(|pair| Some((pair["name"].as_str()?.to_owned(), pair["value"].clone()))).collect();
            spec["env"] = Value::Object(env);
        }
        spec
    }).collect();
    let runtime = super::web::windows_runtime(state).map_err(DesktopError::not_ready)?;
    let launcher = std::env::current_exe().map_err(|e| DesktopError::io(e.to_string()))?;
    let launch = json!({ "launcher": launcher, "workspace": workspace, "environment": environment, "servers": specs });
    let mut child = Command::new(runtime.join("node.exe"))
        .args(["-e", include_str!("../../../../../runtime/agents/local-mcp-bridge.cjs")])
        .current_dir(runtime).env_clear().envs(thingmaker_supervisor::security::EnvironmentProfile::trusted_local().resolve(std::env::vars()))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
        .creation_flags(0x08000000).kill_on_drop(true).spawn().map_err(|e| DesktopError::io(e.to_string()))?;
    let mut input = child.stdin.take().ok_or_else(|| DesktopError::io("Missing MCP bridge control pipe"))?;
    let output = child.stdout.take().ok_or_else(|| DesktopError::io("Missing MCP bridge reply pipe"))?;
    input.write_all(format!("{launch}\n").as_bytes()).await.map_err(|e| DesktopError::io(e.to_string()))?;
    let line = tokio::time::timeout(Duration::from_secs(10), BufReader::new(output).lines().next_line()).await
        .map_err(|_| DesktopError::not_ready("Local MCP bridge startup timed out"))?.map_err(|e| DesktopError::io(e.to_string()))?
        .ok_or_else(|| DesktopError::not_ready("Local MCP bridge exited during startup"))?;
    let endpoints: Vec<Value> = serde_json::from_str(&line).map_err(|_| DesktopError::io("Invalid local MCP bridge reply"))?;
    if servers.len() != endpoints.len() { return Err(DesktopError::io("Missing local MCP endpoints")) }
    for ((server, acp), mut endpoint) in servers.drain(..).zip(endpoints) {
        if acp {
            endpoint["name"] = server["name"].clone();
            endpoint["headers"] = json!([{"name":"Authorization","value":endpoint["headers"]["Authorization"]}]);
        }
        *server = endpoint;
    }
    config.local_mcp_bridge = Some(Arc::new(input));
    tokio::spawn(async move { let _ = child.wait().await; });
    Ok(())
}
