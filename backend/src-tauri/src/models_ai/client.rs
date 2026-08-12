use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    time::Duration,
};

use futures_util::StreamExt;
use reqwest::{redirect::Policy, Client, Response, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use super::contracts::{ChatMessageInput, ChatRole, DataSharing, ModelsAiError};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const METADATA_TIMEOUT: Duration = Duration::from_secs(10);
const CHAT_TIMEOUT: Duration = Duration::from_secs(120);
const PULL_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const PULL_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const DNS_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_PULL_LINE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_PULL_TOTAL_BYTES: usize = 32 * 1024 * 1024;

pub(crate) fn validate_provider_endpoint(value: &str) -> Result<DataSharing, ModelsAiError> {
    if value.trim() != value || value.is_empty() {
        return Err(ModelsAiError::invalid("baseUrl"));
    }
    let url = Url::parse(value).map_err(|_| ModelsAiError::invalid("baseUrl"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|port| port == 0)
    {
        return Err(ModelsAiError::invalid("baseUrl"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| ModelsAiError::invalid("baseUrl"))?;
    let loopback = host
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback());
    match (url.scheme(), loopback) {
        ("http", true) | ("https", true) => Ok(DataSharing::Local),
        ("https", false) => Ok(DataSharing::Remote),
        ("http", false) => Err(ModelsAiError::insecure_transport()),
        _ => Err(ModelsAiError::invalid("baseUrl")),
    }
}

pub(crate) fn bounded_client() -> Result<Client, ModelsAiError> {
    client_builder()
        .build()
        .map_err(|_| ModelsAiError::unavailable())
}

fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
}

#[derive(Clone)]
pub(crate) struct ProviderClient {
    http: Client,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OllamaModel {
    pub(crate) name: String,
    pub(crate) digest: Option<String>,
}

impl ProviderClient {
    pub(crate) fn new() -> Result<Self, ModelsAiError> {
        Ok(Self {
            http: bounded_client()?,
        })
    }

    pub(crate) async fn ollama_version(&self, base: &str) -> Result<String, ModelsAiError> {
        #[derive(Deserialize)]
        struct Version {
            version: String,
        }
        Ok(self
            .get_json::<Version>(endpoint(base, "api/version")?)
            .await?
            .version)
    }

    pub(crate) async fn ollama_models(
        &self,
        base: &str,
    ) -> Result<Vec<OllamaModel>, ModelsAiError> {
        #[derive(Deserialize)]
        struct Tags {
            models: Vec<Tag>,
        }
        #[derive(Deserialize)]
        struct Tag {
            name: Option<String>,
            model: Option<String>,
            digest: Option<String>,
        }
        let tags: Tags = self.get_json(endpoint(base, "api/tags")?).await?;
        if tags.models.len() > 256
            || tags.models.iter().any(|tag| {
                tag.name
                    .as_deref()
                    .or(tag.model.as_deref())
                    .is_none_or(invalid_runtime_name)
                    || tag.digest.as_deref().is_some_and(invalid_ollama_digest)
            })
        {
            return Err(ModelsAiError::invalid_response());
        }
        Ok(tags
            .models
            .into_iter()
            .filter_map(|tag| {
                tag.name.or(tag.model).map(|name| OllamaModel {
                    name,
                    digest: tag.digest,
                })
            })
            .collect())
    }

    pub(crate) async fn openai_models(
        &self,
        base: &str,
        credential: Option<&str>,
    ) -> Result<Vec<String>, ModelsAiError> {
        #[derive(Deserialize)]
        struct Models {
            data: Vec<Model>,
        }
        #[derive(Deserialize)]
        struct Model {
            id: String,
        }
        let response: Models = self
            .get_json_auth(endpoint(base, "models")?, credential)
            .await?;
        if response.data.len() > 256
            || response
                .data
                .iter()
                .any(|model| invalid_runtime_name(&model.id))
        {
            return Err(ModelsAiError::invalid_response());
        }
        Ok(response.data.into_iter().map(|model| model.id).collect())
    }

    pub(crate) async fn ollama_chat(
        &self,
        base: &str,
        model: &str,
        messages: &[ChatMessageInput],
    ) -> Result<String, ModelsAiError> {
        #[derive(Serialize)]
        struct Request<'a> {
            model: &'a str,
            messages: Vec<Message<'a>>,
            stream: bool,
        }
        #[derive(Serialize)]
        struct Message<'a> {
            role: &'a str,
            content: &'a str,
        }
        #[derive(Deserialize)]
        struct Reply {
            message: ReplyMessage,
        }
        #[derive(Deserialize)]
        struct ReplyMessage {
            role: String,
            content: String,
        }
        let request = Request {
            model,
            messages: messages
                .iter()
                .map(|m| Message {
                    role: role_name(m.role),
                    content: &m.content,
                })
                .collect(),
            stream: false,
        };
        let reply: Reply = self
            .post_json(endpoint(base, "api/chat")?, &request, None)
            .await?;
        if reply.message.role != "assistant" || reply.message.content.len() > MAX_RESPONSE_BYTES {
            return Err(ModelsAiError::invalid_response());
        }
        Ok(reply.message.content)
    }

    pub(crate) async fn openai_chat(
        &self,
        base: &str,
        model: &str,
        messages: &[ChatMessageInput],
        credential: Option<&str>,
    ) -> Result<String, ModelsAiError> {
        #[derive(Serialize)]
        struct Request<'a> {
            model: &'a str,
            messages: Vec<Message<'a>>,
            stream: bool,
        }
        #[derive(Serialize)]
        struct Message<'a> {
            role: &'a str,
            content: &'a str,
        }
        #[derive(Deserialize)]
        struct Reply {
            choices: Vec<Choice>,
        }
        #[derive(Deserialize)]
        struct Choice {
            message: ReplyMessage,
        }
        #[derive(Deserialize)]
        struct ReplyMessage {
            role: String,
            content: String,
        }
        let request = Request {
            model,
            messages: messages
                .iter()
                .map(|m| Message {
                    role: role_name(m.role),
                    content: &m.content,
                })
                .collect(),
            stream: false,
        };
        let reply: Reply = self
            .post_json(endpoint(base, "chat/completions")?, &request, credential)
            .await?;
        let Some(choice) = reply.choices.into_iter().next() else {
            return Err(ModelsAiError::invalid_response());
        };
        if choice.message.role != "assistant" || choice.message.content.len() > MAX_RESPONSE_BYTES {
            return Err(ModelsAiError::invalid_response());
        }
        Ok(choice.message.content)
    }

    pub(crate) async fn ollama_delete(&self, base: &str, model: &str) -> Result<(), ModelsAiError> {
        #[derive(Serialize)]
        struct Request<'a> {
            model: &'a str,
        }
        let url = endpoint(base, "api/delete")?;
        let response = self
            .client_for(&url)
            .await?
            .delete(url)
            .timeout(METADATA_TIMEOUT)
            .json(&Request { model })
            .send()
            .await
            .map_err(map_transport)?;
        if response.status().is_success() || response.status().as_u16() == 404 {
            Ok(())
        } else {
            Err(ModelsAiError::unavailable())
        }
    }

    pub(crate) async fn ollama_pull_lines(
        &self,
        base: &str,
        model: &str,
        mut cancel: tokio::sync::watch::Receiver<bool>,
        mut progress: impl FnMut(Option<u64>, Option<u64>) -> Result<(), ModelsAiError>,
    ) -> Result<(), ModelsAiError> {
        #[derive(Serialize)]
        struct Request<'a> {
            model: &'a str,
            stream: bool,
        }
        let url = endpoint(base, "api/pull")?;
        let response = self
            .client_for(&url)
            .await?
            .post(url)
            .timeout(PULL_TIMEOUT)
            .json(&Request {
                model,
                stream: true,
            })
            .send()
            .await
            .map_err(map_transport)?;
        if !response.status().is_success() {
            return Err(ModelsAiError::pull_failed());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_PULL_TOTAL_BYTES as u64)
        {
            return Err(ModelsAiError::response_too_large());
        }
        let mut bytes = response.bytes_stream();
        let mut total = 0usize;
        let mut line = Vec::new();
        let mut completed = false;
        loop {
            let Some(chunk) = (tokio::select! {
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() { return Err(ModelsAiError::pull_cancelled()); }
                    continue;
                },
                chunk = tokio::time::timeout(PULL_IDLE_TIMEOUT, bytes.next()) => chunk.map_err(|_| ModelsAiError::timeout())?,
            }) else {
                break;
            };
            let chunk = chunk.map_err(map_transport)?;
            total = total.saturating_add(chunk.len());
            if total > MAX_PULL_TOTAL_BYTES {
                return Err(ModelsAiError::response_too_large());
            }
            for byte in chunk {
                if *cancel.borrow() {
                    return Err(ModelsAiError::pull_cancelled());
                }
                if byte == b'\n' {
                    parse_pull_line(&line, &mut progress, &mut completed)?;
                    line.clear();
                } else {
                    line.push(byte);
                    if line.len() > MAX_PULL_LINE_BYTES {
                        return Err(ModelsAiError::response_too_large());
                    }
                }
            }
        }
        if !line.is_empty() {
            parse_pull_line(&line, &mut progress, &mut completed)?;
        }
        if completed {
            Ok(())
        } else {
            Err(ModelsAiError::pull_failed())
        }
    }

    async fn get_json<T: DeserializeOwned>(&self, url: Url) -> Result<T, ModelsAiError> {
        self.get_json_auth(url, None).await
    }
    async fn get_json_auth<T: DeserializeOwned>(
        &self,
        url: Url,
        credential: Option<&str>,
    ) -> Result<T, ModelsAiError> {
        let client = self.client_for(&url).await?;
        let mut request = client.get(url).timeout(METADATA_TIMEOUT);
        if let Some(value) = credential {
            request = request.bearer_auth(value);
        }
        parse_json(request.send().await.map_err(map_transport)?).await
    }
    async fn post_json<T: DeserializeOwned, B: Serialize>(
        &self,
        url: Url,
        body: &B,
        credential: Option<&str>,
    ) -> Result<T, ModelsAiError> {
        let client = self.client_for(&url).await?;
        let mut request = client.post(url).timeout(CHAT_TIMEOUT).json(body);
        if let Some(value) = credential {
            request = request.bearer_auth(value);
        }
        parse_json(request.send().await.map_err(map_transport)?).await
    }

    async fn client_for(&self, url: &Url) -> Result<Client, ModelsAiError> {
        if validate_provider_endpoint(url.as_str())? == DataSharing::Local {
            return Ok(self.http.clone());
        }
        let host = url
            .host_str()
            .ok_or_else(|| ModelsAiError::invalid("baseUrl"))?
            .to_owned();
        let port = url
            .port_or_known_default()
            .ok_or_else(|| ModelsAiError::invalid("baseUrl"))?;
        let addresses = tokio::time::timeout(
            DNS_TIMEOUT,
            tokio::task::spawn_blocking({
                let host = host.clone();
                move || {
                    (host.as_str(), port)
                        .to_socket_addrs()
                        .map(|items| items.collect::<Vec<_>>())
                }
            }),
        )
        .await
        .map_err(|_| ModelsAiError::timeout())?
        .map_err(|_| ModelsAiError::unavailable())?
        .map_err(|_| ModelsAiError::unavailable())?;
        validate_remote_addresses(&addresses)?;
        client_builder()
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|_| ModelsAiError::unavailable())
    }
}

fn validate_remote_addresses(addresses: &[SocketAddr]) -> Result<(), ModelsAiError> {
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        Err(ModelsAiError::insecure_transport())
    } else {
        Ok(())
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && matches!(b, 0 | 88 | 168))
        || (a == 198 && matches!(b, 18 | 19 | 51))
        || (a == 203 && b == 0))
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    if let Some(v4) = ip.to_ipv4() {
        return is_public_v4(v4);
    }
    !ip.is_unspecified()
        && !ip.is_loopback()
        && !ip.is_multicast()
        && (segments[0] & 0xfe00) != 0xfc00
        && (segments[0] & 0xffc0) != 0xfe80
        && (segments[0] & 0xffc0) != 0xfec0
        && !(segments[0] == 0x0100 && segments[1] == 0)
        && !(segments[0] == 0x0064
            && segments[1] == 0xff9b
            && segments[2] == 0
            && segments[3] == 0
            && segments[4] == 0
            && segments[5] == 0)
        && !(segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 1)
        && !(segments[0] == 0x2001 && segments[1] <= 0x01ff)
        && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        && segments[0] != 0x2002
}

fn parse_pull_line(
    line: &[u8],
    progress: &mut impl FnMut(Option<u64>, Option<u64>) -> Result<(), ModelsAiError>,
    completed: &mut bool,
) -> Result<(), ModelsAiError> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let value: serde_json::Value =
        serde_json::from_slice(line).map_err(|_| ModelsAiError::invalid_response())?;
    let object = value
        .as_object()
        .ok_or_else(ModelsAiError::invalid_response)?;
    let status = object
        .get("status")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(ModelsAiError::invalid_response)?;
    if object.get("error").is_some() {
        return Err(ModelsAiError::pull_failed());
    }
    let completed_bytes = object.get("completed").and_then(serde_json::Value::as_u64);
    let total_bytes = object.get("total").and_then(serde_json::Value::as_u64);
    if completed_bytes
        .zip(total_bytes)
        .is_some_and(|(done, total)| done > total)
    {
        return Err(ModelsAiError::invalid_response());
    }
    progress(completed_bytes, total_bytes)?;
    if status == "success" {
        *completed = true;
    }
    Ok(())
}

fn endpoint(base: &str, suffix: &str) -> Result<Url, ModelsAiError> {
    validate_provider_endpoint(base)?;
    let mut url = Url::parse(base).map_err(|_| ModelsAiError::invalid("baseUrl"))?;
    let mut segments = url
        .path_segments_mut()
        .map_err(|_| ModelsAiError::invalid("baseUrl"))?;
    for item in suffix.split('/') {
        segments.push(item);
    }
    drop(segments);
    Ok(url)
}

async fn parse_json<T: DeserializeOwned>(response: Response) -> Result<T, ModelsAiError> {
    if !response.status().is_success() {
        return Err(ModelsAiError::unavailable());
    }
    let bytes = checked_response(response).await?;
    serde_json::from_slice(&bytes).map_err(|_| ModelsAiError::invalid_response())
}

async fn checked_response(response: Response) -> Result<Vec<u8>, ModelsAiError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ModelsAiError::response_too_large());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(map_transport)?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(ModelsAiError::response_too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn map_transport(error: reqwest::Error) -> ModelsAiError {
    if error.is_timeout() {
        ModelsAiError::timeout()
    } else {
        ModelsAiError::unavailable()
    }
}
fn role_name(role: ChatRole) -> &'static str {
    match role {
        ChatRole::System => "system",
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
    }
}
fn invalid_runtime_name(value: &str) -> bool {
    value.is_empty() || value.len() > 160 || value.chars().any(char::is_control)
}
fn invalid_ollama_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_none_or(|digest| {
        digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    use super::*;

    fn serve_once(body: &'static str, assert_request: impl Fn(&str) + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let read = stream.read(&mut chunk).unwrap();
                request.extend_from_slice(&chunk[..read]);
                let Some(headers_end) = request.windows(4).position(|item| item == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = std::str::from_utf8(&request[..headers_end]).unwrap();
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length:")
                            .or_else(|| line.strip_prefix("Content-Length:"))
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if request.len() >= headers_end + 4 + content_length {
                    break;
                }
            }
            assert_request(std::str::from_utf8(&request).unwrap());
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).unwrap();
        });
        format!("http://{address}")
    }
    #[test]
    fn endpoint_policy_is_numeric_loopback_http_or_explicit_https() {
        assert_eq!(
            validate_provider_endpoint("http://127.0.0.1:11434").unwrap(),
            DataSharing::Local
        );
        assert!(validate_provider_endpoint("http://localhost:11434").is_err());
        assert!(validate_provider_endpoint("http://api.example.com").is_err());
        assert_eq!(
            validate_provider_endpoint("https://api.example.com/v1").unwrap(),
            DataSharing::Remote
        );
    }
    #[test]
    fn client_disables_proxy_and_redirects() {
        bounded_client().unwrap();
        assert_eq!(
            endpoint("http://127.0.0.1:11434", "api/tags")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:11434/api/tags"
        );
    }

    #[tokio::test]
    async fn provider_envelopes_tolerate_metadata_and_keep_native_auth_in_request_only() {
        let ollama = serve_once(
            r#"{"models":[{"name":"tiny:latest","modified_at":"now","size":1,"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}"#,
            |request| assert!(request.starts_with("GET /api/tags ")),
        );
        assert_eq!(
            ProviderClient::new()
                .unwrap()
                .ollama_models(&ollama)
                .await
                .unwrap(),
            vec![OllamaModel {
                name: "tiny:latest".into(),
                digest: Some(
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        .into()
                )
            }]
        );
        let openai = serve_once(
            r#"{"object":"list","data":[{"id":"remote-model","object":"model","created":1}]}"#,
            |request| {
                assert!(request.starts_with("GET /v1/models "));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer native-secret"));
                assert!(!request.contains("provider credential could"));
            },
        );
        assert_eq!(
            ProviderClient::new()
                .unwrap()
                .openai_models(&format!("{openai}/v1"), Some("native-secret"))
                .await
                .unwrap(),
            vec!["remote-model"]
        );
    }

    #[tokio::test]
    async fn pull_uses_model_and_requires_explicit_success() {
        let base = serve_once(
            "{\"status\":\"pulling manifest\"}\n{\"status\":\"success\"}\n",
            |request| {
                assert!(request.starts_with("POST /api/pull "));
                assert!(request.contains("\"model\":\"lfm\""));
                assert!(!request.contains("\"name\""));
            },
        );
        ProviderClient::new()
            .unwrap()
            .ollama_pull_lines(
                &base,
                "lfm",
                tokio::sync::watch::channel(false).1,
                |_, _| Ok(()),
            )
            .await
            .unwrap();
        let mut complete = false;
        assert!(parse_pull_line(
            br#"{"status":"pulling"}"#,
            &mut |_, _| Ok(()),
            &mut complete
        )
        .is_ok());
        assert!(!complete);
    }

    #[tokio::test]
    async fn chat_envelopes_accept_provider_metadata() {
        let ollama = serve_once(
            r#"{"model":"lfm","created_at":"now","message":{"role":"assistant","content":"hello"},"done":true,"eval_count":1}"#,
            |request| assert!(request.starts_with("POST /api/chat ")),
        );
        let messages = vec![ChatMessageInput {
            role: ChatRole::User,
            content: "hi".into(),
        }];
        assert_eq!(
            ProviderClient::new()
                .unwrap()
                .ollama_chat(&ollama, "lfm", &messages)
                .await
                .unwrap(),
            "hello"
        );
        let openai = serve_once(
            r#"{"id":"x","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"world"},"finish_reason":"stop"}],"usage":{"total_tokens":2}}"#,
            |request| assert!(request.starts_with("POST /v1/chat/completions ")),
        );
        assert_eq!(
            ProviderClient::new()
                .unwrap()
                .openai_chat(&format!("{openai}/v1"), "m", &messages, Some("secret"))
                .await
                .unwrap(),
            "world"
        );
    }

    #[tokio::test]
    async fn delete_uses_model_and_incomplete_or_malformed_pull_fails() {
        let delete = serve_once("{}", |request| {
            assert!(request.starts_with("DELETE /api/delete "));
            assert!(request.contains("\"model\":\"lfm\""));
            assert!(!request.contains("\"name\""));
        });
        ProviderClient::new()
            .unwrap()
            .ollama_delete(&delete, "lfm")
            .await
            .unwrap();
        let incomplete = serve_once("{\"status\":\"pulling\"}\n", |_| {});
        assert!(ProviderClient::new()
            .unwrap()
            .ollama_pull_lines(
                &incomplete,
                "lfm",
                tokio::sync::watch::channel(false).1,
                |_, _| Ok(())
            )
            .await
            .is_err());
        let mut completed = false;
        assert!(parse_pull_line(b"not json", &mut |_, _| Ok(()), &mut completed).is_err());
    }

    #[test]
    fn timeout_policy_keeps_pull_longer_than_metadata_and_chat() {
        assert!(METADATA_TIMEOUT < CHAT_TIMEOUT && CHAT_TIMEOUT < PULL_TIMEOUT);
        assert!(PULL_IDLE_TIMEOUT < CHAT_TIMEOUT);
    }

    #[test]
    fn remote_resolution_accepts_only_public_addresses() {
        for rejected in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:192.168.1.1",
            "::192.168.1.1",
            "64:ff9b::c0a8:101",
            "64:ff9b::808:808",
            "64:ff9b:1::1",
            "100::1",
            "2001:db8::1",
            "2002::1",
            "fc00::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
        ] {
            assert!(!is_public_ip(rejected.parse().unwrap()), "{rejected}");
        }
        for accepted in [
            "1.1.1.1",
            "8.8.8.8",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            assert!(is_public_ip(accepted.parse().unwrap()), "{accepted}");
        }
        assert!(validate_remote_addresses(&[
            "1.1.1.1:443".parse().unwrap(),
            "8.8.8.8:443".parse().unwrap(),
        ])
        .is_ok());
        assert!(validate_remote_addresses(&[
            "1.1.1.1:443".parse().unwrap(),
            "127.0.0.1:443".parse().unwrap(),
        ])
        .is_err());
        client_builder()
            .resolve_to_addrs("api.example.test", &["1.1.1.1:443".parse().unwrap()])
            .build()
            .unwrap();
    }
}
