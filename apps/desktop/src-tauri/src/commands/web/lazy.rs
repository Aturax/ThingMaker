//! MCP discovery runs in the desktop. Only a tool call or the Web panel starts Node.
use super::{Connection, WebSession};
use axum::{Json, Router, extract::State, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, routing::post};
use serde_json::{Value, json};
use std::{path::Path, sync::{Arc, Weak}, time::Duration};
use tokio::sync::Mutex;

#[derive(Clone)]
struct Discovery {
    auth: String,
    tools: Arc<Value>,
    session: Weak<Mutex<WebSession>>,
    client: reqwest::Client,
}

pub(super) async fn listen(session: &Connection, root: &Path) -> Result<Value, String> {
    let tools = std::fs::read(root.join("tools.json")).map_err(|_| "Missing Web tool catalog. Reinstall ThingMaker.")?;
    let tools: Value = serde_json::from_slice(&tools).map_err(|_| "Invalid Web tool catalog")?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let auth = format!("Bearer {}", uuid::Uuid::new_v4());
    let discovery = Discovery {
        auth: auth.clone(), tools: Arc::new(tools), session: Arc::downgrade(session),
        client: reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(120)).build().map_err(|e| e.to_string())?,
    };
    let app = Router::new().route("/mcp", post(request)).with_state(discovery);
    session.lock().await.listener = Some(tokio::spawn(async move { let _ = axum::serve(listener, app).await; }));
    Ok(json!({"name":"thingmaker-web","type":"http","url":format!("http://127.0.0.1:{port}/mcp"),
        "headers":[{"name":"Authorization","value":auth}]}))
}

async fn request(State(state): State<Discovery>, headers: HeaderMap, Json(message): Json<Value>) -> Response {
    if headers.contains_key("origin") || headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(&state.auth) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let method = message["method"].as_str().unwrap_or_default();
    if message["jsonrpc"] != "2.0" || method.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(id) = message.get("id") else { return StatusCode::ACCEPTED.into_response() };
    let result = match method {
        "initialize" => {
            let version = match message["params"]["protocolVersion"].as_str() {
                Some(v @ ("2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25")) => v,
                _ => "2025-11-25",
            };
            json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"thingmaker-web","version":"1.0.0"}})
        }
        "tools/list" => (*state.tools).clone(),
        "ping" => json!({}),
        "tools/call" => return match call_tool(&state, &message).await {
            Ok(reply) => Json(reply).into_response(),
            Err(reason) => Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":reason}})).into_response(),
        },
        _ => return Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})).into_response(),
    };
    Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
}

async fn call_tool(state: &Discovery, message: &Value) -> Result<Value, String> {
    let session = state.session.upgrade().ok_or("The web session closed")?;
    let (url, auth) = session.lock().await.runtime().await?.endpoint.clone();
    // The runtime has its own loopback credential. Release the session lock
    // before the call so the user can still interact with the shared page.
    state.client.post(url).header("authorization", auth).header("accept","application/json, text/event-stream")
        .json(message).send().await.map_err(|_| "The web runtime is unavailable")?
        .error_for_status().map_err(|_| "The web runtime rejected the tool call")?
        .json().await.map_err(|_| "Invalid reply from the web runtime".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires the staged web runtime"]
    async fn the_first_tool_call_starts_the_same_runtime_used_by_the_panel() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::initialize(temp.path(),None).unwrap();
        let (session,entry) = WebSession::launch(&state,true).await.unwrap();
        assert!(session.lock().await.runtime.is_none());
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let result: Value = client.post(entry["url"].as_str().unwrap())
            .header("authorization",entry["headers"][0]["value"].as_str().unwrap())
            .json(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"web_page","arguments":{}}}))
            .send().await.unwrap().json().await.unwrap();
        assert!(result["result"]["content"][0]["text"].as_str().is_some_and(|text| text.contains("no open page")), "{result}");
        let mut live = session.lock().await;
        let pid = live.runtime.as_ref().unwrap().child.id().unwrap();
        assert_eq!(live.control(json!({"kind":"frame"})).await.unwrap()["enabled"],true);
        assert_eq!(live.runtime.as_ref().unwrap().child.id(),Some(pid));
        live.close().await;
    }

    #[tokio::test]
    async fn a_cloud_session_lists_tools_without_starting_the_runtime() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tools.json"), r#"{"tools":[{"name":"web_page"}]}"#).unwrap();
        let session = Arc::new(Mutex::new(WebSession {
            command: tokio::process::Command::new("missing-web-runtime.exe"),
            runtime: None, listener: None, closed: false,
        }));
        let entry = listen(&session, dir.path()).await.unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let request = || client.post(entry["url"].as_str().unwrap())
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}));
        let auth = entry["headers"][0]["value"].as_str().unwrap();
        assert_eq!(request().send().await.unwrap().status(), StatusCode::FORBIDDEN);
        assert_eq!(request().header("authorization", auth).header("origin", "null").send().await.unwrap().status(), StatusCode::FORBIDDEN);
        let response: Value = request().header("authorization", auth).send().await.unwrap().json().await.unwrap();
        assert_eq!(response["result"]["tools"][0]["name"], "web_page");
        assert!(session.lock().await.runtime.is_none());
    }
}
