//! A small MCP server (the Model Context Protocol: JSON-RPC over HTTP) so an AI assistant on this computer, such as Claude Code,
//! can look at the catalog and work in the app once the person has switched it on.
//!
//! It is careful by design: it is off until the person turns it on; it listens on this computer only (127.0.0.1); every request
//! needs the secret token; a request that carries an Origin header (a web page, whatever site it is from) or a Host that is not
//! this computer is refused, so a web page cannot talk to it; it only ever answers POST /mcp with one JSON message at a time, a
//! body of at most 1 MB, and gives up on a slow client after ten seconds. What the tools may do is decided in mcp_tools.rs.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const SERVER_NAME: &str = "lucent-raw";
const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 1024 * 1024;
const MAX_CONNECTIONS: usize = 8;
const LATEST_PROTOCOL: &str = "2025-06-18";
const SUPPORTED: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// One tool the assistant may use.
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema of the arguments.
    pub schema: Value,
    /// It changes nothing.
    pub read_only: bool,
}

pub trait Tools: Send + Sync {
    fn list(&self) -> Vec<ToolDef>;
    /// The tool's answer as text, or what went wrong, in words.
    fn call(&self, name: &str, args: &Value) -> Result<String, String>;
    fn instructions(&self) -> String {
        String::new()
    }
}

pub struct Running {
    stop: Arc<AtomicBool>,
    pub port: u16,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Running {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Compare two secrets without stopping at the first difference.
pub fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(1);
    }
    diff == 0
}

/// Start listening on 127.0.0.1. `port` 0 lets the system choose.
pub fn start(port: u16, token: String, tools: Arc<dyn Tools>) -> Result<Running, String> {
    if token.len() < 24 {
        return Err("The token is too short.".into());
    }
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).map_err(|e| format!("Port {port} could not be used: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let live = Arc::new(AtomicUsize::new(0));
    let flag = stop.clone();
    let handle = std::thread::spawn(move || {
        while !flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    if live.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                        let _ = respond(&stream, 503, "Service Unavailable", &[], "too many connections");
                        continue;
                    }
                    live.fetch_add(1, Ordering::SeqCst);
                    let (token, tools, live) = (token.clone(), tools.clone(), live.clone());
                    std::thread::spawn(move || {
                        let _ = serve_one(stream, port, &token, tools.as_ref());
                        live.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
                Err(_) => std::thread::sleep(Duration::from_millis(200)),
            }
        }
    });
    Ok(Running { stop, port, handle: Some(handle) })
}

fn respond(mut stream: &TcpStream, code: u16, reason: &str, headers: &[(&str, &str)], body: &str) -> std::io::Result<()> {
    let mut out = format!("HTTP/1.1 {code} {reason}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n", body.len());
    if !body.is_empty() && !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
        out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    }
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(body);
    stream.write_all(out.as_bytes())?;
    stream.flush()
}

fn serve_one(mut stream: TcpStream, port: u16, token: &str, tools: &dyn Tools) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    // the head of the request
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEADER {
            return respond(&stream, 431, "Request Header Fields Too Large", &[], "headers too large");
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let header = |name: &str| -> Option<String> {
        head.split("\r\n").skip(1).find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    };
    // only this computer, and never a web page
    let host_ok = header("host").map(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}")).unwrap_or(false);
    if !host_ok || header("origin").is_some() {
        return respond(&stream, 403, "Forbidden", &[], "forbidden");
    }
    if path.split('?').next() != Some("/mcp") {
        return respond(&stream, 404, "Not Found", &[], "not found");
    }
    let bearer = header("authorization").and_then(|a| a.strip_prefix("Bearer ").map(|t| t.trim().to_string()));
    if !bearer.map(|t| same_secret(&t, token)).unwrap_or(false) {
        return respond(&stream, 401, "Unauthorized", &[("WWW-Authenticate", "Bearer")], "a valid token is needed");
    }
    if method != "POST" {
        return respond(&stream, 405, "Method Not Allowed", &[("Allow", "POST")], "use POST");
    }
    let length: usize = match header("content-length").and_then(|v| v.parse().ok()) {
        Some(n) => n,
        None => return respond(&stream, 411, "Length Required", &[], "length required"),
    };
    if length > MAX_BODY {
        return respond(&stream, 413, "Payload Too Large", &[], "body too large");
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    let json_headers = [("Content-Type", "application/json")];
    match handle_message(&body, tools) {
        Some(reply) => respond(&stream, 200, "OK", &json_headers, &reply.to_string())?,
        None => respond(&stream, 202, "Accepted", &[], "")?,
    }
    let _ = stream.shutdown(Shutdown::Both);
    Ok(())
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// The answer to one JSON-RPC message (or a batch of them); nothing for a notification.
pub fn handle_message(body: &[u8], tools: &dyn Tools) -> Option<Value> {
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return Some(error(&Value::Null, -32700, "Parse error: the body is not JSON")),
    };
    match parsed {
        Value::Array(items) if !items.is_empty() => {
            let replies: Vec<Value> = items.iter().filter_map(|m| handle_one(m, tools)).collect();
            (!replies.is_empty()).then(|| Value::Array(replies))
        }
        Value::Array(_) => Some(error(&Value::Null, -32600, "Invalid request: an empty batch")),
        other => handle_one(&other, tools),
    }
}

fn handle_one(msg: &Value, tools: &dyn Tools) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str);
    let Some(method) = method else {
        return Some(error(&id.unwrap_or(Value::Null), -32600, "Invalid request: no method"));
    };
    let Some(id) = id else { return None }; // a notification (such as notifications/initialized) gets no answer
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let ok = |result: Value| Some(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = if SUPPORTED.contains(&asked) { asked } else { LATEST_PROTOCOL };
            ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")},
                "instructions": tools.instructions(),
            }))
        }
        "ping" => ok(json!({})),
        "tools/list" => {
            let list: Vec<Value> = tools
                .list()
                .into_iter()
                .map(|t| json!({"name": t.name, "description": t.description, "inputSchema": t.schema, "annotations": {"readOnlyHint": t.read_only, "destructiveHint": false}}))
                .collect();
            ok(json!({"tools": list}))
        }
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            if !tools.list().iter().any(|t| t.name == name) {
                return Some(error(&id, -32602, &format!("Unknown tool: {name}")));
            }
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if !args.is_object() {
                return Some(error(&id, -32602, "The arguments must be an object"));
            }
            match tools.call(name, &args) {
                Ok(text) => ok(json!({"content": [{"type": "text", "text": text}], "isError": false})),
                Err(e) => ok(json!({"content": [{"type": "text", "text": e}], "isError": true})),
            }
        }
        other => Some(error(&id, -32601, &format!("Method not found: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;
    impl Tools for Fake {
        fn list(&self) -> Vec<ToolDef> {
            vec![
                ToolDef { name: "echo", description: "Say it back", schema: json!({"type": "object", "properties": {"text": {"type": "string"}}}), read_only: true },
                ToolDef { name: "fail", description: "Always fails", schema: json!({"type": "object"}), read_only: false },
            ]
        }
        fn call(&self, name: &str, args: &Value) -> Result<String, String> {
            match name {
                "echo" => Ok(args.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
                _ => Err("it failed, in words".into()),
            }
        }
        fn instructions(&self) -> String {
            "be careful".into()
        }
    }

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    /// One request over a real socket: (status, body).
    fn http(port: u16, method: &str, path: &str, headers: &[(&str, String)], body: &str) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut req = format!("{method} {path} HTTP/1.1\r\n");
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        let status = out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        (status, out.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
    }
    fn good(port: u16) -> Vec<(&'static str, String)> {
        vec![("Host", format!("127.0.0.1:{port}")), ("Authorization", format!("Bearer {TOKEN}")), ("Content-Type", "application/json".into())]
    }
    fn rpc(port: u16, v: Value) -> (u16, Value) {
        let (c, b) = http(port, "POST", "/mcp", &good(port), &v.to_string());
        (c, serde_json::from_str(&b).unwrap_or(Value::Null))
    }
    fn up() -> Running {
        start(0, TOKEN.into(), Arc::new(Fake)).unwrap()
    }

    #[test]
    fn secrets_are_compared_whole() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd") && !same_secret("abc", "ab") && !same_secret("", "x") && !same_secret("abc", "abcd"));
    }

    #[test]
    fn initialize_agrees_a_version_and_names_the_server_and_a_notification_gets_no_answer() {
        let s = up();
        let (c, r) = rpc(s.port, json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}));
        assert_eq!(c, 200);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "lucent-raw");
        assert_eq!(r["result"]["instructions"], "be careful");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        let (_, r) = rpc(s.port, json!({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}}));
        assert_eq!(r["result"]["protocolVersion"], LATEST_PROTOCOL, "an unknown version gets the newest one we speak");
        let (c, body) = http(s.port, "POST", "/mcp", &good(s.port), r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert_eq!((c, body.as_str()), (202, ""));
        let (_, r) = rpc(s.port, json!({"jsonrpc": "2.0", "id": 3, "method": "ping"}));
        assert_eq!(r["result"], json!({}));
        s.stop();
    }

    #[test]
    fn tools_are_listed_with_what_they_do_and_called_and_a_failure_is_an_answer_not_a_crash() {
        let s = up();
        let (_, r) = rpc(s.port, json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}));
        let tools = r["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["annotations"]["readOnlyHint"], true);
        assert_eq!(tools[1]["annotations"]["readOnlyHint"], false);
        assert_eq!(tools[0]["inputSchema"]["type"], "object");
        let (_, r) = rpc(s.port, json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "echo", "arguments": {"text": "hello"}}}));
        assert_eq!((r["result"]["content"][0]["text"].as_str(), r["result"]["isError"].as_bool()), (Some("hello"), Some(false)));
        let (_, r) = rpc(s.port, json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "fail", "arguments": {}}}));
        assert_eq!((r["result"]["content"][0]["text"].as_str(), r["result"]["isError"].as_bool()), (Some("it failed, in words"), Some(true)));
        let (_, r) = rpc(s.port, json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "nope"}}));
        assert_eq!(r["error"]["code"], -32602);
        let (_, r) = rpc(s.port, json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "echo", "arguments": [1]}}));
        assert_eq!(r["error"]["code"], -32602, "arguments must be an object");
        let (_, r) = rpc(s.port, json!({"jsonrpc": "2.0", "id": 6, "method": "no/such"}));
        assert_eq!(r["error"]["code"], -32601);
        s.stop();
    }

    #[test]
    fn bad_json_an_empty_batch_and_a_batch_are_each_answered_properly() {
        let s = up();
        let (c, b) = http(s.port, "POST", "/mcp", &good(s.port), "{not json");
        assert_eq!(c, 200);
        assert!(b.contains("-32700"), "{b}");
        let (_, r) = rpc(s.port, json!([]));
        assert_eq!(r["error"]["code"], -32600);
        let (_, r) = rpc(s.port, json!([{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}, {"jsonrpc": "2.0", "id": 2, "method": "ping"}]));
        assert_eq!(r.as_array().unwrap().len(), 2, "the notification in the batch has no answer");
        let (_, r) = rpc(s.port, json!({"jsonrpc": "2.0", "id": 9}));
        assert_eq!(r["error"]["code"], -32600, "no method");
        s.stop();
    }

    #[test]
    fn a_request_without_the_token_or_with_a_wrong_one_is_refused() {
        let s = up();
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let host = ("Host", format!("127.0.0.1:{}", s.port));
        assert_eq!(http(s.port, "POST", "/mcp", &[host.clone()], body).0, 401, "no token");
        assert_eq!(http(s.port, "POST", "/mcp", &[host.clone(), ("Authorization", "Bearer wrong".into())], body).0, 401);
        assert_eq!(http(s.port, "POST", "/mcp", &[host.clone(), ("Authorization", format!("Bearer {TOKEN}x"))], body).0, 401, "a longer token");
        assert_eq!(http(s.port, "POST", "/mcp", &[host.clone(), ("Authorization", format!("Basic {TOKEN}"))], body).0, 401, "the wrong kind of header");
        assert_eq!(http(s.port, "POST", "/mcp", &good(s.port), body).0, 200);
        s.stop();
    }

    #[test]
    fn a_web_page_or_another_host_cannot_reach_it_even_with_the_token() {
        let s = up();
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let mut with_origin = good(s.port);
        with_origin.push(("Origin", "https://evil.example".into()));
        assert_eq!(http(s.port, "POST", "/mcp", &with_origin, body).0, 403, "any Origin, from any site");
        let mut with_null = good(s.port);
        with_null.push(("Origin", "null".into()));
        assert_eq!(http(s.port, "POST", "/mcp", &with_null, body).0, 403);
        let mut other_host = good(s.port);
        other_host[0] = ("Host", "evil.example".into());
        assert_eq!(http(s.port, "POST", "/mcp", &other_host, body).0, 403, "a name that points here (DNS rebinding)");
        let mut localhost = good(s.port);
        localhost[0] = ("Host", format!("localhost:{}", s.port));
        assert_eq!(http(s.port, "POST", "/mcp", &localhost, body).0, 200, "localhost is this computer");
        s.stop();
    }

    #[test]
    fn only_post_to_mcp_is_answered_and_a_body_that_is_too_big_or_has_no_length_is_refused() {
        let s = up();
        assert_eq!(http(s.port, "GET", "/mcp", &good(s.port), "").0, 405);
        assert_eq!(http(s.port, "DELETE", "/mcp", &good(s.port), "").0, 405);
        assert_eq!(http(s.port, "POST", "/other", &good(s.port), "{}").0, 404);
        assert_eq!(http(s.port, "POST", "/mcp", &good(s.port), &"x".repeat(MAX_BODY + 1)).0, 413);
        // no Content-Length at all
        let mut raw = TcpStream::connect(("127.0.0.1", s.port)).unwrap();
        raw.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        raw.write_all(format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n", s.port).as_bytes()).unwrap();
        let mut out = String::new();
        let _ = raw.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 411"), "{out}");
        s.stop();
    }

    #[test]
    fn a_short_token_is_not_accepted_at_start_and_a_stopped_server_lets_go_of_its_port() {
        assert!(start(0, "short".into(), Arc::new(Fake)).is_err());
        let s = up();
        let port = s.port;
        s.stop();
        assert!(TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(500)).is_err(), "nothing is listening any more");
        // the same port can be used again
        let again = start(port, TOKEN.into(), Arc::new(Fake)).unwrap();
        assert_eq!(again.port, port);
        again.stop();
    }
}
