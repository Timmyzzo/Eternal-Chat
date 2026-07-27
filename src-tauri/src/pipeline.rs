use std::{collections::HashMap, sync::Mutex, time::Duration};

use reqwest::{
    header::{HeaderName, HeaderValue},
    redirect::Policy,
    Client, Method, Url,
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeField {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeRequest {
    pub request_id: String,
    pub url: String,
    pub method: String,
    pub headers: Vec<PipeField>,
    pub query: Vec<PipeField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PipeErrorKind {
    InvalidRequest,
    Network,
    Http,
    Cancelled,
    Stream,
    ChannelClosed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeError {
    pub kind: PipeErrorKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PipeEvent {
    Data {
        #[serde(rename = "requestId")]
        request_id: String,
        data: Vec<String>,
    },
    Done {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Error {
        #[serde(rename = "requestId")]
        request_id: String,
        error: PipeError,
    },
}

pub struct Pipeline {
    client: Client,
    running: Mutex<HashMap<String, CancellationToken>>,
}

impl Default for Pipeline {
    fn default() -> Self {
        let client = Client::builder()
            .redirect(Policy::none())
            .build()
            .expect("the static HTTP client configuration must be valid");

        Self {
            client,
            running: Mutex::new(HashMap::new()),
        }
    }
}

impl Pipeline {
    async fn start<F>(&self, request: PipeRequest, mut emit: F) -> Result<(), String>
    where
        F: FnMut(PipeEvent) -> Result<(), String> + Send,
    {
        let request_id = request.request_id.clone();

        if request_id.trim().is_empty() {
            return emit(PipeEvent::Error {
                request_id,
                error: PipeError::invalid_request(),
            });
        }

        let cancellation = CancellationToken::new();
        if !self.register(&request_id, cancellation.clone())? {
            return emit(PipeEvent::Error {
                request_id,
                error: PipeError::duplicate_request(),
            });
        }

        let outcome = self.execute(&request, &cancellation, &mut emit).await;
        self.unregister(&request_id)?;

        let terminal_event = match outcome {
            Ok(()) => PipeEvent::Done { request_id },
            Err(error) => PipeEvent::Error { request_id, error },
        };

        emit(terminal_event)
    }

    fn cancel(&self, request_id: &str) -> Result<(), String> {
        let running = self
            .running
            .lock()
            .map_err(|_| "The stream registry is unavailable.".to_owned())?;

        if let Some(cancellation) = running.get(request_id) {
            cancellation.cancel();
        }

        Ok(())
    }

    async fn execute<F>(
        &self,
        request: &PipeRequest,
        cancellation: &CancellationToken,
        emit: &mut F,
    ) -> Result<(), PipeError>
    where
        F: FnMut(PipeEvent) -> Result<(), String> + Send,
    {
        let request_builder = self.build_request(request)?;
        let mut response = tokio::select! {
            _ = cancellation.cancelled() => return Err(PipeError::cancelled()),
            response = request_builder.send() => {
                response.map_err(|_| PipeError::network())?
            }
        };

        if !response.status().is_success() {
            return Err(PipeError::http(response.status().as_u16()));
        }

        let mut decoder = SseDecoder::default();

        loop {
            let chunk = tokio::select! {
                _ = cancellation.cancelled() => return Err(PipeError::cancelled()),
                chunk = response.chunk() => {
                    chunk.map_err(|_| PipeError::stream())?
                }
            };

            match chunk {
                Some(bytes) => {
                    for data in decoder.push(&bytes)? {
                        emit(PipeEvent::Data {
                            request_id: request.request_id.clone(),
                            data: vec![data],
                        })
                        .map_err(|_| PipeError::channel_closed())?;
                    }
                }
                None => {
                    for data in decoder.finish()? {
                        emit(PipeEvent::Data {
                            request_id: request.request_id.clone(),
                            data: vec![data],
                        })
                        .map_err(|_| PipeError::channel_closed())?;
                    }
                    return Ok(());
                }
            }
        }
    }

    fn build_request(&self, request: &PipeRequest) -> Result<reqwest::RequestBuilder, PipeError> {
        let method = Method::from_bytes(request.method.as_bytes())
            .map_err(|_| PipeError::invalid_request())?;
        let mut url = Url::parse(&request.url).map_err(|_| PipeError::invalid_request())?;

        if !request.query.is_empty() {
            let mut query = url.query_pairs_mut();
            for field in &request.query {
                query.append_pair(&field.name, &field.value);
            }
        }

        let mut builder = self.client.request(method, url);

        for field in &request.headers {
            let name = HeaderName::from_bytes(field.name.as_bytes())
                .map_err(|_| PipeError::invalid_request())?;
            let value =
                HeaderValue::from_str(&field.value).map_err(|_| PipeError::invalid_request())?;
            builder = builder.header(name, value);
        }

        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }

        if let Some(timeout_ms) = request.timeout_ms {
            if timeout_ms == 0 {
                return Err(PipeError::invalid_request());
            }
            builder = builder.timeout(Duration::from_millis(timeout_ms));
        }

        Ok(builder)
    }

    fn register(&self, request_id: &str, cancellation: CancellationToken) -> Result<bool, String> {
        let mut running = self
            .running
            .lock()
            .map_err(|_| "The stream registry is unavailable.".to_owned())?;

        if running.contains_key(request_id) {
            return Ok(false);
        }

        running.insert(request_id.to_owned(), cancellation);
        Ok(true)
    }

    fn unregister(&self, request_id: &str) -> Result<(), String> {
        self.running
            .lock()
            .map_err(|_| "The stream registry is unavailable.".to_owned())?
            .remove(request_id);
        Ok(())
    }

    #[cfg(test)]
    fn running_count(&self) -> usize {
        self.running.lock().expect("stream registry lock").len()
    }
}

impl PipeError {
    fn new(kind: PipeErrorKind, message: &str) -> Self {
        Self {
            kind,
            message: message.to_owned(),
            status: None,
            body: None,
        }
    }

    fn invalid_request() -> Self {
        Self::new(
            PipeErrorKind::InvalidRequest,
            "The transport request is invalid.",
        )
    }

    fn duplicate_request() -> Self {
        Self::new(
            PipeErrorKind::InvalidRequest,
            "A stream with this request ID is already running.",
        )
    }

    fn network() -> Self {
        Self::new(PipeErrorKind::Network, "The HTTP request failed.")
    }

    fn http(status: u16) -> Self {
        Self {
            kind: PipeErrorKind::Http,
            message: format!("The server returned HTTP {status}."),
            status: Some(status),
            body: None,
        }
    }

    fn cancelled() -> Self {
        Self::new(PipeErrorKind::Cancelled, "The stream was cancelled.")
    }

    fn stream() -> Self {
        Self::new(PipeErrorKind::Stream, "The response stream failed.")
    }

    fn channel_closed() -> Self {
        Self::new(
            PipeErrorKind::ChannelClosed,
            "The desktop event channel is closed.",
        )
    }
}

#[derive(Default)]
struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, PipeError> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();

        while let Some((index, delimiter_length)) = next_event_boundary(&self.buffer) {
            let frame = self.buffer[..index].to_vec();
            self.buffer.drain(..index + delimiter_length);
            if let Some(data) = parse_sse_frame(&frame)? {
                events.push(data);
            }
        }

        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<String>, PipeError> {
        if self.buffer.is_empty() {
            return Ok(Vec::new());
        }

        let frame = std::mem::take(&mut self.buffer);
        Ok(parse_sse_frame(&frame)?.into_iter().collect())
    }
}

fn next_event_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let line_feed = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2));
    let carriage_return = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4));

    match (line_feed, carriage_return) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(boundary), None) | (None, Some(boundary)) => Some(boundary),
        (None, None) => None,
    }
}

fn parse_sse_frame(frame: &[u8]) -> Result<Option<String>, PipeError> {
    let text = std::str::from_utf8(frame).map_err(|_| PipeError::stream())?;
    let mut data_lines = Vec::new();

    for line in text.lines() {
        if line == "data" {
            data_lines.push("");
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(value.strip_prefix(' ').unwrap_or(value));
        }
    }

    if data_lines.is_empty() {
        Ok(None)
    } else {
        Ok(Some(data_lines.join("\n")))
    }
}

#[tauri::command]
pub async fn start_stream(
    request: PipeRequest,
    on_event: Channel<PipeEvent>,
    pipeline: State<'_, Pipeline>,
) -> Result<(), String> {
    pipeline
        .start(request, |event| {
            on_event
                .send(event)
                .map_err(|_| "The desktop event channel is closed.".to_owned())
        })
        .await
}

#[tauri::command]
pub fn cancel_stream(request_id: String, pipeline: State<'_, Pipeline>) -> Result<(), String> {
    pipeline.cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde::Deserialize;
    use tauri::ipc::InvokeResponseBody;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
    };

    use super::*;

    const CONTRACT_FIXTURE: &str = include_str!("../../src/test/fixtures/pipe-contract.json");

    #[derive(Debug, Deserialize, Serialize)]
    struct ContractFixture {
        request: PipeRequest,
        events: Vec<PipeEvent>,
    }

    #[test]
    fn shared_fixture_matches_the_rust_contract() {
        let fixture: ContractFixture =
            serde_json::from_str(CONTRACT_FIXTURE).expect("valid shared pipe fixture");
        let actual = serde_json::to_value(fixture).expect("serializable pipe fixture");
        let expected: serde_json::Value =
            serde_json::from_str(CONTRACT_FIXTURE).expect("valid fixture JSON");

        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn sends_the_final_request_and_forwards_raw_sse_data_in_order() {
        let sse_body = "data: {\"delta\":\"first\"}\n\ndata: second\n\n";
        let (base_url, captured_request, server) = spawn_sse_fixture(sse_body).await;
        let pipeline = Pipeline::default();
        let events = Arc::new(Mutex::new(Vec::<PipeEvent>::new()));
        let event_log = Arc::clone(&events);
        let channel = Channel::<PipeEvent>::new(move |body| {
            let event = match body {
                InvokeResponseBody::Json(json) => {
                    serde_json::from_str(&json).expect("serialized PipeEvent")
                }
                InvokeResponseBody::Raw(bytes) => {
                    serde_json::from_slice(&bytes).expect("serialized PipeEvent bytes")
                }
            };
            event_log.lock().expect("event log lock").push(event);
            Ok(())
        });
        let body = "{\"opaque\":{\"custom_key\":\"custom-value\"}}";

        pipeline
            .start(
                PipeRequest {
                    request_id: "request-success".to_owned(),
                    url: format!("{base_url}/stream?existing=keep"),
                    method: "POST".to_owned(),
                    headers: vec![
                        PipeField {
                            name: "Content-Type".to_owned(),
                            value: "application/json".to_owned(),
                        },
                        PipeField {
                            name: "X-Eternal-Test".to_owned(),
                            value: "exact-value".to_owned(),
                        },
                    ],
                    query: vec![
                        PipeField {
                            name: "Mode".to_owned(),
                            value: "raw".to_owned(),
                        },
                        PipeField {
                            name: "Mode".to_owned(),
                            value: "duplicate".to_owned(),
                        },
                    ],
                    body: Some(body.to_owned()),
                    timeout_ms: Some(5_000),
                },
                move |event| channel.send(event).map_err(|error| error.to_string()),
            )
            .await
            .expect("successful local stream");

        let request = captured_request.await.expect("captured local request");
        server.await.expect("local fixture server");

        assert!(
            request.starts_with("POST /stream?existing=keep&Mode=raw&Mode=duplicate HTTP/1.1\r\n")
        );
        assert!(request
            .to_ascii_lowercase()
            .contains("\r\nx-eternal-test: exact-value\r\n"));
        assert_eq!(
            request.split_once("\r\n\r\n").expect("request body").1,
            body
        );
        assert_eq!(
            *events.lock().expect("event log lock"),
            vec![
                PipeEvent::Data {
                    request_id: "request-success".to_owned(),
                    data: vec!["{\"delta\":\"first\"}".to_owned()],
                },
                PipeEvent::Data {
                    request_id: "request-success".to_owned(),
                    data: vec!["second".to_owned()],
                },
                PipeEvent::Done {
                    request_id: "request-success".to_owned(),
                },
            ]
        );
        assert_eq!(pipeline.running_count(), 0);
    }

    async fn spawn_sse_fixture(
        sse_body: &str,
    ) -> (
        String,
        oneshot::Receiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local fixture server");
        let address = listener.local_addr().expect("local fixture address");
        let response_body = sse_body.to_owned();
        let (request_sender, request_receiver) = oneshot::channel();

        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept local request");
            let mut request = Vec::new();
            let mut read_buffer = [0_u8; 1024];

            let request_length = loop {
                let count = socket
                    .read(&mut read_buffer)
                    .await
                    .expect("read local request");
                assert!(
                    count > 0,
                    "client closed before sending the complete request"
                );
                request.extend_from_slice(&read_buffer[..count]);

                if let Some(length) = complete_request_length(&request) {
                    if request.len() >= length {
                        break length;
                    }
                }
            };

            request.truncate(request_length);
            request_sender
                .send(String::from_utf8(request).expect("UTF-8 local request"))
                .expect("send captured request");

            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            );
            socket
                .write_all(headers.as_bytes())
                .await
                .expect("write response headers");
            socket
                .write_all(response_body.as_bytes())
                .await
                .expect("write SSE body");
        });

        (format!("http://{address}"), request_receiver, server)
    }

    fn complete_request_length(request: &[u8]) -> Option<usize> {
        let header_end = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")?
            + 4;
        let headers = std::str::from_utf8(&request[..header_end]).ok()?;
        let content_length = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        });

        Some(header_end + content_length.unwrap_or(0))
    }
}
