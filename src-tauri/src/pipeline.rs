use std::{collections::HashMap, future::pending, sync::Mutex, time::Duration};

use reqwest::{
    header::{HeaderName, HeaderValue},
    redirect::Policy,
    Client, Method, Url,
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};
use tokio::time::{sleep_until, Instant};
use tokio_util::sync::CancellationToken;

const DATA_BATCH_FLUSH_INTERVAL: Duration = Duration::from_millis(30);
const DATA_BATCH_MAX_EVENTS: usize = 64;
// This cap covers the combined UTF-8 bytes of the raw data payloads in one event batch.
const DATA_BATCH_MAX_BYTES: usize = 256 * 1024;
const HTTP_ERROR_BODY_MAX_BYTES: usize = 16 * 1024;
const SSE_LINE_MAX_BYTES: usize = DATA_BATCH_MAX_BYTES + 1024;
const REDACTION_MARKER: &str = "[redacted]";

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
    Timeout,
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

        let _running_guard = RunningRequestGuard::new(self, request_id.clone());
        let outcome = self.execute(&request, &cancellation, &mut emit).await;

        if matches!(
            outcome,
            Err(PipeError {
                kind: PipeErrorKind::ChannelClosed,
                ..
            })
        ) {
            return Err("The desktop event channel is closed.".to_owned());
        }

        let terminal_event = match outcome {
            Ok(()) => PipeEvent::Done { request_id },
            Err(error) => PipeEvent::Error { request_id, error },
        };

        emit(terminal_event)
    }

    fn cancel(&self, request_id: &str) -> Result<(), String> {
        let cancellation = self
            .running
            .lock()
            .map_err(|_| "The stream registry is unavailable.".to_owned())?
            .get(request_id)
            .cloned();

        if let Some(cancellation) = cancellation {
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
        let started_at = Instant::now();
        let request_builder = self.build_request(request)?;
        let deadline = request
            .timeout_ms
            .map(|timeout_ms| started_at + Duration::from_millis(timeout_ms));
        let lifecycle_timeout = wait_for_deadline(deadline);
        tokio::pin!(lifecycle_timeout);

        let mut response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(PipeError::cancelled()),
            _ = &mut lifecycle_timeout => return Err(PipeError::timeout()),
            response = request_builder.send() => {
                response.map_err(PipeError::from_request_error)?
            }
        };

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let mut body = Vec::new();

            while body.len() < HTTP_ERROR_BODY_MAX_BYTES {
                let chunk = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(PipeError::cancelled()),
                    _ = &mut lifecycle_timeout => return Err(PipeError::timeout()),
                    chunk = response.chunk() => chunk,
                };

                match chunk {
                    Ok(Some(bytes)) => {
                        let remaining = HTTP_ERROR_BODY_MAX_BYTES - body.len();
                        body.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                        if bytes.len() >= remaining {
                            break;
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }

            return Err(PipeError::http(status, limited_error_body(&body, request)));
        }

        let mut decoder = SseDecoder::default();
        let mut batch = DataBatch::default();

        loop {
            let flush_deadline = batch.flush_deadline();

            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(PipeError::cancelled()),
                _ = &mut lifecycle_timeout => {
                    batch.flush(&request.request_id, emit)?;
                    return Err(PipeError::timeout());
                }
                _ = wait_for_deadline(flush_deadline), if flush_deadline.is_some() => {
                    batch.flush(&request.request_id, emit)?;
                }
                chunk = response.chunk() => {
                    match chunk {
                        Ok(Some(bytes)) => {
                            let result = decoder.push(&bytes, |data| {
                                queue_data(
                                    &mut batch,
                                    data,
                                    &request.request_id,
                                    cancellation,
                                    emit,
                                )
                            });

                            if let Err(error) = result {
                                if matches!(
                                    error.kind,
                                    PipeErrorKind::Cancelled | PipeErrorKind::ChannelClosed
                                ) {
                                    return Err(error);
                                }
                                batch.flush(&request.request_id, emit)?;
                                return Err(error);
                            }
                        }
                        Ok(None) => {
                            let result = decoder.finish(|data| {
                                queue_data(
                                    &mut batch,
                                    data,
                                    &request.request_id,
                                    cancellation,
                                    emit,
                                )
                            });

                            if let Err(error) = result {
                                if matches!(
                                    error.kind,
                                    PipeErrorKind::Cancelled | PipeErrorKind::ChannelClosed
                                ) {
                                    return Err(error);
                                }
                                batch.flush(&request.request_id, emit)?;
                                return Err(error);
                            }

                            batch.flush(&request.request_id, emit)?;
                            return Ok(());
                        }
                        Err(error) => {
                            batch.flush(&request.request_id, emit)?;
                            return Err(PipeError::from_stream_error(error));
                        }
                    }
                }
            }
        }
    }

    fn build_request(&self, request: &PipeRequest) -> Result<reqwest::RequestBuilder, PipeError> {
        if matches!(request.timeout_ms, Some(0)) {
            return Err(PipeError::invalid_request());
        }

        let method = Method::from_bytes(request.method.as_bytes())
            .map_err(|_| PipeError::invalid_request())?;
        let url = final_url(request)?;
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

struct RunningRequestGuard<'a> {
    pipeline: &'a Pipeline,
    request_id: String,
}

impl<'a> RunningRequestGuard<'a> {
    fn new(pipeline: &'a Pipeline, request_id: String) -> Self {
        Self {
            pipeline,
            request_id,
        }
    }
}

impl Drop for RunningRequestGuard<'_> {
    fn drop(&mut self) {
        let _ = self.pipeline.unregister(&self.request_id);
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

    fn http(status: u16, body: Option<String>) -> Self {
        Self {
            kind: PipeErrorKind::Http,
            message: format!("The server returned HTTP {status}."),
            status: Some(status),
            body,
        }
    }

    fn timeout() -> Self {
        Self::new(PipeErrorKind::Timeout, "The transport request timed out.")
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

    fn from_request_error(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::timeout()
        } else {
            Self::network()
        }
    }

    fn from_stream_error(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::timeout()
        } else {
            Self::stream()
        }
    }
}

#[derive(Default)]
struct DataBatch {
    data: Vec<String>,
    payload_bytes: usize,
    started_at: Option<Instant>,
}

impl DataBatch {
    fn flush_deadline(&self) -> Option<Instant> {
        self.started_at
            .map(|started_at| started_at + DATA_BATCH_FLUSH_INTERVAL)
    }

    fn would_exceed_bytes(&self, data: &str) -> bool {
        !self.data.is_empty() && self.payload_bytes + data.len() > DATA_BATCH_MAX_BYTES
    }

    fn push(&mut self, data: String) -> Result<bool, PipeError> {
        if data.len() > DATA_BATCH_MAX_BYTES {
            return Err(PipeError::stream());
        }

        if self.data.is_empty() {
            self.started_at = Some(Instant::now());
        }

        self.payload_bytes += data.len();
        self.data.push(data);

        Ok(self.data.len() >= DATA_BATCH_MAX_EVENTS || self.payload_bytes >= DATA_BATCH_MAX_BYTES)
    }

    fn flush<F>(&mut self, request_id: &str, emit: &mut F) -> Result<(), PipeError>
    where
        F: FnMut(PipeEvent) -> Result<(), String>,
    {
        if self.data.is_empty() {
            return Ok(());
        }

        let data = std::mem::take(&mut self.data);
        self.payload_bytes = 0;
        self.started_at = None;

        emit(PipeEvent::Data {
            request_id: request_id.to_owned(),
            data,
        })
        .map_err(|_| PipeError::channel_closed())
    }
}

fn queue_data<F>(
    batch: &mut DataBatch,
    data: String,
    request_id: &str,
    cancellation: &CancellationToken,
    emit: &mut F,
) -> Result<(), PipeError>
where
    F: FnMut(PipeEvent) -> Result<(), String>,
{
    if cancellation.is_cancelled() {
        return Err(PipeError::cancelled());
    }

    if batch.would_exceed_bytes(&data) {
        batch.flush(request_id, emit)?;
        if cancellation.is_cancelled() {
            return Err(PipeError::cancelled());
        }
    }

    if batch.push(data)? {
        batch.flush(request_id, emit)?;
    }

    Ok(())
}

async fn wait_for_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => pending::<()>().await,
    }
}

fn final_url(request: &PipeRequest) -> Result<Url, PipeError> {
    let mut url = Url::parse(&request.url).map_err(|_| PipeError::invalid_request())?;

    if !request.query.is_empty() {
        let mut query = url.query_pairs_mut();
        for field in &request.query {
            query.append_pair(&field.name, &field.value);
        }
    }

    Ok(url)
}

fn limited_error_body(bytes: &[u8], request: &PipeRequest) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    let mut text = String::from_utf8_lossy(bytes).into_owned();
    let mut sensitive_values = request_sensitive_values(request);
    sensitive_values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    sensitive_values.dedup();

    for value in sensitive_values {
        text = text.replace(&value, REDACTION_MARKER);
    }

    if text.len() > HTTP_ERROR_BODY_MAX_BYTES {
        let mut boundary = HTTP_ERROR_BODY_MAX_BYTES;
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
    }

    (!text.is_empty()).then_some(text)
}

fn request_sensitive_values(request: &PipeRequest) -> Vec<String> {
    let mut values = Vec::new();

    if !request.url.is_empty() {
        values.push(request.url.clone());
    }

    if let Ok(url) = final_url(request) {
        values.push(url.as_str().to_owned());
        if let Some(query) = url.query() {
            values.push(query.to_owned());
        }
        values.extend(
            url.query_pairs()
                .map(|(_, value)| value.into_owned())
                .filter(|value| !value.is_empty()),
        );
    }

    values.extend(
        request
            .headers
            .iter()
            .chain(request.query.iter())
            .map(|field| field.value.clone())
            .filter(|value| !value.is_empty()),
    );

    if let Some(body) = request.body.as_ref().filter(|body| !body.is_empty()) {
        values.push(body.clone());
    }

    values
}

#[derive(Default)]
struct SseDecoder {
    buffer: Vec<u8>,
    data_lines: Vec<String>,
    data_bytes: usize,
}

impl SseDecoder {
    fn push<F>(&mut self, bytes: &[u8], mut on_data: F) -> Result<(), PipeError>
    where
        F: FnMut(String) -> Result<(), PipeError>,
    {
        self.buffer.extend_from_slice(bytes);
        self.process_complete_lines(false, &mut on_data)?;

        if self.buffer.len() > SSE_LINE_MAX_BYTES {
            return Err(PipeError::stream());
        }

        Ok(())
    }

    fn finish<F>(&mut self, mut on_data: F) -> Result<(), PipeError>
    where
        F: FnMut(String) -> Result<(), PipeError>,
    {
        self.process_complete_lines(true, &mut on_data)?;

        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            self.process_line(&line, &mut on_data)?;
        }

        self.dispatch_event(&mut on_data)
    }

    fn process_complete_lines<F>(
        &mut self,
        allow_trailing_carriage_return: bool,
        on_data: &mut F,
    ) -> Result<(), PipeError>
    where
        F: FnMut(String) -> Result<(), PipeError>,
    {
        while let Some((index, delimiter_length)) =
            next_line_boundary(&self.buffer, allow_trailing_carriage_return)
        {
            if index > SSE_LINE_MAX_BYTES {
                return Err(PipeError::stream());
            }

            let line = self.buffer[..index].to_vec();
            self.buffer.drain(..index + delimiter_length);
            self.process_line(&line, on_data)?;
        }

        Ok(())
    }

    fn process_line<F>(&mut self, line: &[u8], on_data: &mut F) -> Result<(), PipeError>
    where
        F: FnMut(String) -> Result<(), PipeError>,
    {
        if line.is_empty() {
            return self.dispatch_event(on_data);
        }

        if line.first() == Some(&b':') {
            return Ok(());
        }

        let (field, value) = match line.iter().position(|byte| *byte == b':') {
            Some(index) => (&line[..index], &line[index + 1..]),
            None => (line, &[][..]),
        };

        if field != b"data" {
            return Ok(());
        }

        let value = value.strip_prefix(b" ").unwrap_or(value);
        let value = std::str::from_utf8(value).map_err(|_| PipeError::stream())?;
        let separator_bytes = usize::from(!self.data_lines.is_empty());

        if self.data_bytes + separator_bytes + value.len() > DATA_BATCH_MAX_BYTES {
            return Err(PipeError::stream());
        }

        self.data_bytes += separator_bytes + value.len();
        self.data_lines.push(value.to_owned());
        Ok(())
    }

    fn dispatch_event<F>(&mut self, on_data: &mut F) -> Result<(), PipeError>
    where
        F: FnMut(String) -> Result<(), PipeError>,
    {
        if self.data_lines.is_empty() {
            return Ok(());
        }

        let data = self.data_lines.join("\n");
        self.data_lines.clear();
        self.data_bytes = 0;
        on_data(data)
    }
}

fn next_line_boundary(
    buffer: &[u8],
    allow_trailing_carriage_return: bool,
) -> Option<(usize, usize)> {
    for (index, byte) in buffer.iter().enumerate() {
        match byte {
            b'\n' => return Some((index, 1)),
            b'\r' if index + 1 < buffer.len() => {
                return Some((index, usize::from(buffer[index + 1] == b'\n') + 1));
            }
            b'\r' if allow_trailing_carriage_return => return Some((index, 1)),
            _ => {}
        }
    }

    None
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
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    use serde::Deserialize;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::oneshot,
        task::JoinHandle,
        time::{advance, timeout},
    };

    use super::*;

    const CONTRACT_FIXTURE: &str = include_str!("../../src/test/fixtures/pipe-contract.json");

    type EventLog = Arc<Mutex<Vec<PipeEvent>>>;

    #[derive(Debug, Deserialize, Serialize)]
    struct ContractFixture {
        request: PipeRequest,
        events: Vec<PipeEvent>,
    }

    enum FixtureStep {
        Write(Vec<u8>),
        Delay(Duration),
        Signal(oneshot::Sender<()>),
        Wait(oneshot::Receiver<()>),
        ObserveClose(oneshot::Sender<()>),
        Close,
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

    #[test]
    fn decoder_handles_bytewise_boundaries_multiline_empty_data_and_comments() {
        let input = b": heartbeat\r\nevent: ping\r\n\r\ndata: first\r\ndata: second\r\n\r\ndata\n\ndata: tail\n\n";
        let mut decoder = SseDecoder::default();
        let mut events = Vec::new();

        for byte in input {
            decoder
                .push(&[*byte], |data| {
                    events.push(data);
                    Ok(())
                })
                .expect("bytewise SSE input");
        }
        decoder
            .finish(|data| {
                events.push(data);
                Ok(())
            })
            .expect("finish bytewise SSE input");

        assert_eq!(events, vec!["first\nsecond", "", "tail"]);
    }

    #[test]
    fn decoder_handles_deterministic_random_fragments_and_multiple_events_per_chunk() {
        let input = b"data: one\n\ndata: two\r\n\r\ndata: three";
        let fragments = deterministic_fragments(input, 7);
        let mut decoder = SseDecoder::default();
        let mut events = Vec::new();

        for fragment in fragments {
            decoder
                .push(&fragment, |data| {
                    events.push(data);
                    Ok(())
                })
                .expect("fragmented SSE input");
        }
        decoder
            .finish(|data| {
                events.push(data);
                Ok(())
            })
            .expect("finish fragmented SSE input");

        assert_eq!(events, vec!["one", "two", "three"]);
    }

    #[tokio::test]
    async fn sends_the_final_request_and_flushes_before_done() {
        let sse_body = b"data: {\"delta\":\"first\"}\n\ndata: second\n\n";
        let response = fixed_response("200 OK", sse_body, sse_body.len());
        let (base_url, captured_request, server) =
            spawn_fixture(vec![FixtureStep::Write(response)]).await;
        let pipeline = Pipeline::default();
        let events = event_log();
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
                record_events(&events),
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
            snapshot(&events),
            vec![
                PipeEvent::Data {
                    request_id: "request-success".to_owned(),
                    data: vec!["{\"delta\":\"first\"}".to_owned(), "second".to_owned()],
                },
                PipeEvent::Done {
                    request_id: "request-success".to_owned(),
                },
            ]
        );
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test]
    async fn fixture_supports_deterministic_random_response_fragmentation() {
        let values = vec!["one".to_owned(), "two".to_owned(), "three".to_owned()];
        let body = sse_body(&values);
        let mut steps = vec![FixtureStep::Write(fixed_headers("200 OK", body.len()))];
        steps.extend(
            deterministic_fragments(&body, 23)
                .into_iter()
                .map(FixtureStep::Write),
        );
        let (base_url, _, server) = spawn_fixture(steps).await;
        let pipeline = Pipeline::default();
        let events = event_log();

        pipeline
            .start(
                basic_request("request-fragments", &base_url, Some(5_000)),
                record_events(&events),
            )
            .await
            .expect("fragmented response stream");
        server.await.expect("fixture server");

        assert_eq!(data_batches(&events), vec![values]);
        assert!(matches!(
            snapshot(&events).last(),
            Some(PipeEvent::Done { .. })
        ));
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn flushes_a_pending_batch_after_thirty_milliseconds() {
        let (written_sender, written_receiver) = oneshot::channel();
        let (release_sender, release_receiver) = oneshot::channel();
        let (base_url, _, server) = spawn_fixture(vec![
            FixtureStep::Write(chunked_headers("200 OK")),
            FixtureStep::Write(http_chunk(b"data: delayed\n\n")),
            FixtureStep::Signal(written_sender),
            FixtureStep::Wait(release_receiver),
            FixtureStep::Write(chunked_end()),
        ])
        .await;
        let pipeline = Arc::new(Pipeline::default());
        let events = event_log();
        let task = spawn_start(
            Arc::clone(&pipeline),
            basic_request("request-timer", &base_url, None),
            Arc::clone(&events),
        );

        written_receiver.await.expect("fixture wrote first chunk");
        settle().await;
        assert!(snapshot(&events).is_empty());

        advance(Duration::from_millis(29)).await;
        settle().await;
        assert!(snapshot(&events).is_empty());

        advance(Duration::from_millis(1)).await;
        settle().await;
        assert_eq!(data_batches(&events), vec![vec!["delayed".to_owned()]]);

        release_sender.send(()).expect("release fixture EOF");
        task.await
            .expect("stream task")
            .expect("successful timed batch stream");
        server.await.expect("fixture server");
        assert!(matches!(
            snapshot(&events).last(),
            Some(PipeEvent::Done { .. })
        ));
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test]
    async fn flushes_immediately_at_sixty_four_events_without_reordering() {
        let values: Vec<String> = (0..DATA_BATCH_MAX_EVENTS)
            .map(|index| format!("event-{index:02}"))
            .collect();
        let body = sse_body(&values);
        let (written_sender, written_receiver) = oneshot::channel();
        let (release_sender, release_receiver) = oneshot::channel();
        let (base_url, _, server) = spawn_fixture(vec![
            FixtureStep::Write(chunked_headers("200 OK")),
            FixtureStep::Write(http_chunk(&body)),
            FixtureStep::Signal(written_sender),
            FixtureStep::Wait(release_receiver),
            FixtureStep::Write(chunked_end()),
        ])
        .await;
        let pipeline = Arc::new(Pipeline::default());
        let events = event_log();
        let task = spawn_start(
            Arc::clone(&pipeline),
            basic_request("request-count", &base_url, Some(5_000)),
            Arc::clone(&events),
        );

        written_receiver.await.expect("fixture wrote event batch");
        wait_for_data_batches(&events, 1).await;
        assert_eq!(data_batches(&events), vec![values]);

        release_sender.send(()).expect("release fixture EOF");
        task.await
            .expect("stream task")
            .expect("successful count-limited batch stream");
        server.await.expect("fixture server");
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_every_batch_within_the_named_byte_cap() {
        let first = "a".repeat(150 * 1024);
        let second = "b".repeat(150 * 1024);
        let body = sse_body(&[first.clone(), second.clone()]);
        let (written_sender, written_receiver) = oneshot::channel();
        let (release_sender, release_receiver) = oneshot::channel();
        let (base_url, _, server) = spawn_fixture(vec![
            FixtureStep::Write(chunked_headers("200 OK")),
            FixtureStep::Write(http_chunk(&body)),
            FixtureStep::Signal(written_sender),
            FixtureStep::Wait(release_receiver),
            FixtureStep::Write(chunked_end()),
        ])
        .await;
        let pipeline = Arc::new(Pipeline::default());
        let events = event_log();
        let task = spawn_start(
            Arc::clone(&pipeline),
            basic_request("request-bytes", &base_url, None),
            Arc::clone(&events),
        );

        written_receiver.await.expect("fixture wrote large events");
        wait_for_data_batches(&events, 1).await;
        assert_eq!(data_batches(&events), vec![vec![first.clone()]]);

        advance(DATA_BATCH_FLUSH_INTERVAL).await;
        wait_for_data_batches(&events, 2).await;
        let batches = data_batches(&events);
        assert_eq!(batches, vec![vec![first], vec![second]]);
        assert!(batches.iter().all(|batch| {
            batch.iter().map(|data| data.len()).sum::<usize>() <= DATA_BATCH_MAX_BYTES
        }));

        release_sender.send(()).expect("release fixture EOF");
        task.await
            .expect("stream task")
            .expect("successful byte-limited batch stream");
        server.await.expect("fixture server");
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test]
    async fn rejects_an_oversized_single_data_event_as_a_stream_error() {
        let value = "x".repeat(DATA_BATCH_MAX_BYTES + 1);
        let body = sse_body(&[value]);
        let response = fixed_response("200 OK", &body, body.len());
        let (base_url, _, server) = spawn_fixture(vec![FixtureStep::Write(response)]).await;
        let pipeline = Pipeline::default();
        let events = event_log();

        pipeline
            .start(
                basic_request("request-oversized", &base_url, Some(5_000)),
                record_events(&events),
            )
            .await
            .expect("stream error is delivered as an event");
        server.await.expect("fixture server");

        assert_error_kind(&events, PipeErrorKind::Stream);
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test]
    async fn invalid_requests_emit_one_terminal_event_and_cleanup() {
        let pipeline = Pipeline::default();
        let events = event_log();
        let mut request = basic_request("request-invalid", "not a URL", Some(5_000));
        request.timeout_ms = Some(0);

        pipeline
            .start(request, record_events(&events))
            .await
            .expect("invalid request is delivered as an event");

        assert_error_kind(&events, PipeErrorKind::InvalidRequest);
        assert_eq!(terminal_count(&events), 1);
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test]
    async fn duplicate_ids_are_rejected_and_unknown_cancellation_is_a_noop() {
        let (ready_sender, ready_receiver) = oneshot::channel();
        let (closed_sender, closed_receiver) = oneshot::channel();
        let (base_url, _, server) = spawn_fixture(vec![
            FixtureStep::Write(chunked_headers("200 OK")),
            FixtureStep::Signal(ready_sender),
            FixtureStep::ObserveClose(closed_sender),
        ])
        .await;
        let pipeline = Arc::new(Pipeline::default());
        let first_events = event_log();
        let first_task = spawn_start(
            Arc::clone(&pipeline),
            basic_request("request-duplicate", &base_url, Some(5_000)),
            Arc::clone(&first_events),
        );

        ready_receiver.await.expect("fixture is ready");
        assert_eq!(pipeline.running_count(), 1);
        pipeline.cancel("unknown-request").expect("unknown cancel");
        assert_eq!(pipeline.running_count(), 1);

        let duplicate_events = event_log();
        pipeline
            .start(
                basic_request("request-duplicate", &base_url, Some(5_000)),
                record_events(&duplicate_events),
            )
            .await
            .expect("duplicate error delivered");
        assert_error_kind(&duplicate_events, PipeErrorKind::InvalidRequest);
        assert_eq!(pipeline.running_count(), 1);

        pipeline
            .cancel("request-duplicate")
            .expect("cancel original request");
        first_task
            .await
            .expect("first stream task")
            .expect("cancel event delivered");
        timeout(Duration::from_secs(1), closed_receiver)
            .await
            .expect("reader closed promptly")
            .expect("close signal");
        server.await.expect("fixture server");
        assert_error_kind(&first_events, PipeErrorKind::Cancelled);
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_pre_cancelled_token_wins_before_the_request_is_sent() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local listener");
        let address = listener.local_addr().expect("local address");
        let pipeline = Pipeline::default();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let mut emit = |_event| Ok(());

        let outcome = pipeline
            .execute(
                &basic_request(
                    "request-pre-cancelled",
                    &format!("http://{address}"),
                    Some(5_000),
                ),
                &cancellation,
                &mut emit,
            )
            .await;

        assert_eq!(
            outcome.expect_err("cancelled outcome").kind,
            PipeErrorKind::Cancelled
        );
        assert!(timeout(Duration::from_millis(1), listener.accept())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cancellation_before_the_first_body_chunk_cleans_reader_and_registry() {
        let (ready_sender, ready_receiver) = oneshot::channel();
        let (closed_sender, closed_receiver) = oneshot::channel();
        let (base_url, _, server) = spawn_fixture(vec![
            FixtureStep::Write(chunked_headers("200 OK")),
            FixtureStep::Signal(ready_sender),
            FixtureStep::ObserveClose(closed_sender),
        ])
        .await;
        let pipeline = Arc::new(Pipeline::default());
        let events = event_log();
        let task = spawn_start(
            Arc::clone(&pipeline),
            basic_request("request-first-body", &base_url, Some(5_000)),
            Arc::clone(&events),
        );

        ready_receiver.await.expect("response headers written");
        pipeline
            .cancel("request-first-body")
            .expect("cancel before first body chunk");
        task.await
            .expect("stream task")
            .expect("cancel event delivered");
        timeout(Duration::from_secs(1), closed_receiver)
            .await
            .expect("reader closed promptly")
            .expect("close signal");
        server.await.expect("fixture server");

        assert_error_kind(&events, PipeErrorKind::Cancelled);
        assert_eq!(terminal_count(&events), 1);
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_does_not_wait_for_a_large_pending_batch() {
        let values: Vec<String> = (0..DATA_BATCH_MAX_EVENTS - 1)
            .map(|index| format!("queued-{index}"))
            .collect();
        let body = sse_body(&values);
        let (written_sender, written_receiver) = oneshot::channel();
        let (release_sender, release_receiver) = oneshot::channel();
        let (base_url, _, server) = spawn_fixture(vec![
            FixtureStep::Write(chunked_headers("200 OK")),
            FixtureStep::Write(http_chunk(&body)),
            FixtureStep::Signal(written_sender),
            FixtureStep::Wait(release_receiver),
            FixtureStep::Write(chunked_end()),
        ])
        .await;
        let pipeline = Arc::new(Pipeline::default());
        let events = event_log();
        let task = spawn_start(
            Arc::clone(&pipeline),
            basic_request("request-pending-cancel", &base_url, None),
            Arc::clone(&events),
        );

        written_receiver.await.expect("fixture wrote pending batch");
        settle().await;
        assert!(snapshot(&events).is_empty());

        pipeline
            .cancel("request-pending-cancel")
            .expect("cancel pending batch");
        task.await
            .expect("stream task")
            .expect("cancel event delivered without advancing time");
        assert_error_kind(&events, PipeErrorKind::Cancelled);
        assert!(data_batches(&events).is_empty());
        assert_eq!(pipeline.running_count(), 0);

        let _ = release_sender.send(());
        server.await.expect("fixture server");
    }

    #[tokio::test]
    async fn cancellation_while_streaming_preserves_sent_order_and_has_one_terminal() {
        let values: Vec<String> = (0..DATA_BATCH_MAX_EVENTS)
            .map(|index| format!("sent-{index}"))
            .collect();
        let body = sse_body(&values);
        let (written_sender, written_receiver) = oneshot::channel();
        let (closed_sender, closed_receiver) = oneshot::channel();
        let (base_url, _, server) = spawn_fixture(vec![
            FixtureStep::Write(chunked_headers("200 OK")),
            FixtureStep::Write(http_chunk(&body)),
            FixtureStep::Signal(written_sender),
            FixtureStep::ObserveClose(closed_sender),
        ])
        .await;
        let pipeline = Arc::new(Pipeline::default());
        let events = event_log();
        let task = spawn_start(
            Arc::clone(&pipeline),
            basic_request("request-stream-cancel", &base_url, Some(5_000)),
            Arc::clone(&events),
        );

        written_receiver
            .await
            .expect("fixture wrote streaming batch");
        wait_for_data_batches(&events, 1).await;
        pipeline
            .cancel("request-stream-cancel")
            .expect("cancel streaming request");
        task.await
            .expect("stream task")
            .expect("cancel event delivered");
        timeout(Duration::from_secs(1), closed_receiver)
            .await
            .expect("reader closed promptly")
            .expect("close signal");
        server.await.expect("fixture server");

        assert_eq!(data_batches(&events), vec![values]);
        assert_error_kind(&events, PipeErrorKind::Cancelled);
        assert_eq!(terminal_count(&events), 1);
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test]
    async fn cancellation_and_eof_race_produces_exactly_one_terminal_event() {
        let values: Vec<String> = (0..DATA_BATCH_MAX_EVENTS)
            .map(|index| format!("race-{index}"))
            .collect();
        let body = sse_body(&values);
        let (written_sender, written_receiver) = oneshot::channel();
        let (release_sender, release_receiver) = oneshot::channel();
        let (base_url, _, server) = spawn_fixture(vec![
            FixtureStep::Write(chunked_headers("200 OK")),
            FixtureStep::Write(http_chunk(&body)),
            FixtureStep::Signal(written_sender),
            FixtureStep::Wait(release_receiver),
            FixtureStep::Write(chunked_end()),
        ])
        .await;
        let pipeline = Arc::new(Pipeline::default());
        let events = event_log();
        let task = spawn_start(
            Arc::clone(&pipeline),
            basic_request("request-race", &base_url, Some(5_000)),
            Arc::clone(&events),
        );

        written_receiver.await.expect("fixture wrote race batch");
        wait_for_data_batches(&events, 1).await;
        pipeline
            .cancel("request-race")
            .expect("cancel race request");
        release_sender.send(()).expect("release EOF concurrently");
        task.await
            .expect("stream task")
            .expect("one terminal event delivered");
        server.await.expect("fixture server");

        assert_eq!(terminal_count(&events), 1);
        assert_eq!(pipeline.running_count(), 0);
        pipeline
            .cancel("request-race")
            .expect("late cancel is a no-op");
        assert_eq!(terminal_count(&events), 1);
    }

    #[tokio::test]
    async fn non_success_body_is_bounded_and_request_values_are_redacted() {
        let private_url_value = "private-url-value";
        let private_query_value = "private-query-value";
        let private_header_value = "private-header-value";
        let private_body = "{\"private\":\"private-body-value\"}";
        let mut response_body = format!(
            "visible {private_url_value} {private_query_value} {private_header_value} {private_body} "
        );
        response_body.push_str(&"z".repeat(HTTP_ERROR_BODY_MAX_BYTES * 2));
        let response = fixed_response(
            "422 Unprocessable Entity",
            response_body.as_bytes(),
            response_body.len(),
        );
        let (base_url, captured_request, server) =
            spawn_fixture(vec![FixtureStep::Write(response)]).await;
        let pipeline = Pipeline::default();
        let events = event_log();
        let request = PipeRequest {
            request_id: "request-http".to_owned(),
            url: format!("{base_url}/failure?existing={private_url_value}"),
            method: "POST".to_owned(),
            headers: vec![PipeField {
                name: "X-Private".to_owned(),
                value: private_header_value.to_owned(),
            }],
            query: vec![PipeField {
                name: "private".to_owned(),
                value: private_query_value.to_owned(),
            }],
            body: Some(private_body.to_owned()),
            timeout_ms: Some(5_000),
        };

        pipeline
            .start(request, record_events(&events))
            .await
            .expect("HTTP error delivered");
        let _ = captured_request.await.expect("captured error request");
        server.await.expect("fixture server");

        let error = only_error(&events);
        assert_eq!(error.kind, PipeErrorKind::Http);
        assert_eq!(error.status, Some(422));
        let body = error.body.expect("bounded error body");
        assert!(body.len() <= HTTP_ERROR_BODY_MAX_BYTES);
        assert!(body.contains("visible"));
        assert!(body.contains(REDACTION_MARKER));
        for private in [
            private_url_value,
            private_query_value,
            private_header_value,
            private_body,
        ] {
            assert!(!body.contains(private));
        }
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test]
    async fn connection_failure_is_classified_as_network_and_cleans_registry() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind disposable listener");
        let address = listener.local_addr().expect("disposable address");
        drop(listener);
        let pipeline = Pipeline::default();
        let events = event_log();

        pipeline
            .start(
                basic_request("request-network", &format!("http://{address}"), Some(5_000)),
                record_events(&events),
            )
            .await
            .expect("network error delivered");

        assert_error_kind(&events, PipeErrorKind::Network);
        assert_eq!(terminal_count(&events), 1);
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test]
    async fn timeout_covers_connection_and_stream_lifecycle_with_fake_time() {
        let (closed_sender, closed_receiver) = oneshot::channel();
        let (base_url, captured_request, server) = spawn_fixture(vec![
            FixtureStep::Delay(Duration::from_secs(120)),
            FixtureStep::ObserveClose(closed_sender),
        ])
        .await;
        let pipeline = Arc::new(Pipeline::default());
        let events = event_log();
        let task = spawn_start(
            Arc::clone(&pipeline),
            basic_request("request-timeout", &base_url, Some(60_000)),
            Arc::clone(&events),
        );

        let _ = captured_request.await.expect("fixture accepted request");
        tokio::time::pause();
        advance(Duration::from_secs(59)).await;
        settle().await;
        assert!(snapshot(&events).is_empty());
        assert_eq!(pipeline.running_count(), 1);

        advance(Duration::from_secs(2)).await;
        task.await
            .expect("stream task")
            .expect("timeout event delivered");
        assert_error_kind(&events, PipeErrorKind::Timeout);
        assert_eq!(pipeline.running_count(), 0);

        advance(Duration::from_secs(120)).await;
        closed_receiver.await.expect("reader close observed");
        server.await.expect("fixture server");
    }

    #[tokio::test]
    async fn timeout_also_covers_an_active_response_stream_with_fake_time() {
        let values: Vec<String> = (0..DATA_BATCH_MAX_EVENTS)
            .map(|index| format!("before-timeout-{index}"))
            .collect();
        let body = sse_body(&values);
        let (written_sender, written_receiver) = oneshot::channel();
        let (closed_sender, closed_receiver) = oneshot::channel();
        let (base_url, _, server) = spawn_fixture(vec![
            FixtureStep::Write(chunked_headers("200 OK")),
            FixtureStep::Write(http_chunk(&body)),
            FixtureStep::Signal(written_sender),
            FixtureStep::Delay(Duration::from_secs(120)),
            FixtureStep::ObserveClose(closed_sender),
        ])
        .await;
        let pipeline = Arc::new(Pipeline::default());
        let events = event_log();
        let task = spawn_start(
            Arc::clone(&pipeline),
            basic_request("request-stream-timeout", &base_url, Some(60_000)),
            Arc::clone(&events),
        );

        written_receiver.await.expect("fixture wrote response data");
        wait_for_data_batches(&events, 1).await;
        tokio::time::pause();

        advance(Duration::from_secs(59)).await;
        settle().await;
        assert_eq!(terminal_count(&events), 0);
        assert_eq!(pipeline.running_count(), 1);

        advance(Duration::from_secs(2)).await;
        task.await
            .expect("stream task")
            .expect("timeout event delivered");
        assert_eq!(data_batches(&events), vec![values]);
        assert_error_kind(&events, PipeErrorKind::Timeout);
        assert_eq!(terminal_count(&events), 1);
        assert_eq!(pipeline.running_count(), 0);

        advance(Duration::from_secs(120)).await;
        closed_receiver.await.expect("reader close observed");
        server.await.expect("fixture server");
    }

    #[tokio::test]
    async fn abrupt_disconnect_flushes_received_data_then_emits_stream_error() {
        let body = b"data: partial\n\n";
        let response = fixed_response("200 OK", body, body.len() + 100);
        let (base_url, _, server) =
            spawn_fixture(vec![FixtureStep::Write(response), FixtureStep::Close]).await;
        let pipeline = Pipeline::default();
        let events = event_log();

        pipeline
            .start(
                basic_request("request-disconnect", &base_url, Some(5_000)),
                record_events(&events),
            )
            .await
            .expect("stream error delivered");
        server.await.expect("fixture server");

        assert_eq!(data_batches(&events), vec![vec!["partial".to_owned()]]);
        assert_error_kind(&events, PipeErrorKind::Stream);
        assert_eq!(terminal_count(&events), 1);
        assert_eq!(pipeline.running_count(), 0);
    }

    #[tokio::test]
    async fn channel_close_stops_reading_without_a_second_send_and_cleans_registry() {
        let values: Vec<String> = (0..DATA_BATCH_MAX_EVENTS)
            .map(|index| format!("channel-{index}"))
            .collect();
        let body = sse_body(&values);
        let (closed_sender, closed_receiver) = oneshot::channel();
        let (base_url, _, server) = spawn_fixture(vec![
            FixtureStep::Write(chunked_headers("200 OK")),
            FixtureStep::Write(http_chunk(&body)),
            FixtureStep::ObserveClose(closed_sender),
        ])
        .await;
        let pipeline = Pipeline::default();
        let sends = Arc::new(AtomicUsize::new(0));
        let send_count = Arc::clone(&sends);

        let result = pipeline
            .start(
                basic_request("request-channel", &base_url, Some(5_000)),
                move |_event| {
                    send_count.fetch_add(1, Ordering::SeqCst);
                    Err("closed".to_owned())
                },
            )
            .await;

        assert!(result.is_err());
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        assert_eq!(pipeline.running_count(), 0);
        timeout(Duration::from_secs(1), closed_receiver)
            .await
            .expect("reader closed promptly")
            .expect("close signal");
        server.await.expect("fixture server");
    }

    fn basic_request(request_id: &str, base_url: &str, timeout_ms: Option<u64>) -> PipeRequest {
        PipeRequest {
            request_id: request_id.to_owned(),
            url: format!("{base_url}/stream"),
            method: "GET".to_owned(),
            headers: Vec::new(),
            query: Vec::new(),
            body: None,
            timeout_ms,
        }
    }

    fn event_log() -> EventLog {
        Arc::new(Mutex::new(Vec::new()))
    }

    fn record_events(
        events: &EventLog,
    ) -> impl FnMut(PipeEvent) -> Result<(), String> + Send + 'static {
        let events = Arc::clone(events);
        move |event| {
            events.lock().expect("event log lock").push(event);
            Ok(())
        }
    }

    fn spawn_start(
        pipeline: Arc<Pipeline>,
        request: PipeRequest,
        events: EventLog,
    ) -> JoinHandle<Result<(), String>> {
        tokio::spawn(async move { pipeline.start(request, record_events(&events)).await })
    }

    fn snapshot(events: &EventLog) -> Vec<PipeEvent> {
        events.lock().expect("event log lock").clone()
    }

    fn data_batches(events: &EventLog) -> Vec<Vec<String>> {
        snapshot(events)
            .into_iter()
            .filter_map(|event| match event {
                PipeEvent::Data { data, .. } => Some(data),
                _ => None,
            })
            .collect()
    }

    fn only_error(events: &EventLog) -> PipeError {
        let errors: Vec<PipeError> = snapshot(events)
            .into_iter()
            .filter_map(|event| match event {
                PipeEvent::Error { error, .. } => Some(error),
                _ => None,
            })
            .collect();
        assert_eq!(errors.len(), 1);
        errors.into_iter().next().expect("one error")
    }

    fn assert_error_kind(events: &EventLog, kind: PipeErrorKind) {
        assert_eq!(only_error(events).kind, kind);
    }

    fn terminal_count(events: &EventLog) -> usize {
        snapshot(events)
            .iter()
            .filter(|event| matches!(event, PipeEvent::Done { .. } | PipeEvent::Error { .. }))
            .count()
    }

    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    async fn wait_for_data_batches(events: &EventLog, expected: usize) {
        for _ in 0..1_000 {
            if data_batches(events).len() >= expected {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("timed out waiting for {expected} data batches");
    }

    fn sse_body(values: &[String]) -> Vec<u8> {
        let mut body = Vec::new();
        for value in values {
            body.extend_from_slice(b"data: ");
            body.extend_from_slice(value.as_bytes());
            body.extend_from_slice(b"\n\n");
        }
        body
    }

    fn deterministic_fragments(input: &[u8], mut state: u64) -> Vec<Vec<u8>> {
        let mut fragments = Vec::new();
        let mut offset = 0;

        while offset < input.len() {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let length = ((state >> 32) as usize % 7 + 1).min(input.len() - offset);
            fragments.push(input[offset..offset + length].to_vec());
            offset += length;
        }

        fragments
    }

    fn fixed_response(status: &str, body: &[u8], declared_length: usize) -> Vec<u8> {
        let mut response = fixed_headers(status, declared_length);
        response.extend_from_slice(body);
        response
    }

    fn fixed_headers(status: &str, declared_length: usize) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {declared_length}\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    fn chunked_headers(status: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    fn http_chunk(body: &[u8]) -> Vec<u8> {
        let mut chunk = format!("{:X}\r\n", body.len()).into_bytes();
        chunk.extend_from_slice(body);
        chunk.extend_from_slice(b"\r\n");
        chunk
    }

    fn chunked_end() -> Vec<u8> {
        b"0\r\n\r\n".to_vec()
    }

    async fn spawn_fixture(
        steps: Vec<FixtureStep>,
    ) -> (
        String,
        oneshot::Receiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local fixture server");
        let address = listener.local_addr().expect("local fixture address");
        let (request_sender, request_receiver) = oneshot::channel();

        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept local request");
            let request = read_request(&mut socket).await;
            let _ = request_sender.send(request);

            for step in steps {
                match step {
                    FixtureStep::Write(bytes) => {
                        if socket.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                    FixtureStep::Delay(duration) => tokio::time::sleep(duration).await,
                    FixtureStep::Signal(sender) => {
                        let _ = sender.send(());
                    }
                    FixtureStep::Wait(receiver) => {
                        let _ = receiver.await;
                    }
                    FixtureStep::ObserveClose(sender) => {
                        observe_close(&mut socket).await;
                        let _ = sender.send(());
                    }
                    FixtureStep::Close => break,
                }
            }
        });

        (format!("http://{address}"), request_receiver, server)
    }

    async fn read_request(socket: &mut TcpStream) -> String {
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
        String::from_utf8(request).expect("UTF-8 local request")
    }

    async fn observe_close(socket: &mut TcpStream) {
        let mut byte = [0_u8; 1];
        loop {
            match socket.read(&mut byte).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
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
