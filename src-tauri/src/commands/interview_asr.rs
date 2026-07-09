use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        handshake::client::Request as WsClientRequest,
        http::{HeaderMap, HeaderValue},
        Message,
    },
};
use uuid::Uuid;

const EVENT_STATUS: &str = "interview-asr://status";
const EVENT_TRANSCRIPT: &str = "interview-asr://transcript";
const EVENT_DIAGNOSTIC: &str = "interview-asr://diagnostic";

const HEADER_VERSION: u8 = 0x1;
const HEADER_SIZE_WORDS: u8 = 0x1;
const MESSAGE_TYPE_FULL_CLIENT_REQUEST: u8 = 0x1;
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST: u8 = 0x2;
const MESSAGE_TYPE_FULL_SERVER_RESPONSE: u8 = 0x9;
const MESSAGE_TYPE_ERROR: u8 = 0xf;
const FLAG_NO_SEQUENCE: u8 = 0x0;
const FLAG_FINAL_NO_SEQUENCE: u8 = 0x2;
const SERIALIZATION_NONE: u8 = 0x0;
const SERIALIZATION_JSON: u8 = 0x1;
const COMPRESSION_NONE: u8 = 0x0;
const COMPRESSION_GZIP: u8 = 0x1;

#[derive(Default)]
pub struct InterviewAsrState {
    sessions: Mutex<HashMap<String, AsrSessionHandle>>,
}

#[derive(Debug)]
struct AsrSessionHandle {
    sender: mpsc::Sender<AsrOutbound>,
    source: AudioSourceKind,
}

#[derive(Debug)]
enum AsrOutbound {
    Audio {
        sequence: i32,
        pcm16: Vec<u8>,
        is_final: bool,
    },
    Stop {
        reason: StopReason,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AudioSourceKind {
    System,
    Microphone,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewAsrAudioConfig {
    pub format: String,
    pub codec: String,
    pub rate: u32,
    pub bits: u16,
    pub channel: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewAsrRequestConfig {
    pub model_name: String,
    pub enable_nonstream: bool,
    pub show_utterances: bool,
    pub result_type: String,
    pub end_window_size_ms: u32,
    pub force_to_speech_time_ms: u32,
    pub enable_speaker_info: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewAsrStartSessionRequest {
    pub session_id: String,
    pub stream_id: String,
    pub source: AudioSourceKind,
    pub endpoint: String,
    pub resource_id: String,
    pub api_key: String,
    pub request_id: Option<String>,
    pub audio: InterviewAsrAudioConfig,
    pub request: InterviewAsrRequestConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewAsrStartSessionResponse {
    pub session_id: String,
    pub stream_id: String,
    pub request_id: String,
    pub status: String,
    pub service_log_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewAsrPushAudioRequest {
    pub session_id: String,
    pub stream_id: String,
    pub sequence: i32,
    pub pcm16: Vec<u8>,
    pub is_final: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewAsrPushAudioResponse {
    pub accepted: bool,
    pub session_id: String,
    pub stream_id: String,
    pub sequence: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    UserStop,
    SourceEnded,
    Retry,
    Failure,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewAsrStopSessionRequest {
    pub session_id: String,
    pub stream_id: String,
    pub reason: StopReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewAsrStopSessionResponse {
    pub session_id: String,
    pub stream_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrStatusEvent {
    session_id: String,
    stream_id: Option<String>,
    source: Option<AudioSourceKind>,
    status: String,
    level: String,
    message: String,
    retry_attempt: Option<u32>,
    service_log_id: Option<String>,
    error_code: Option<String>,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrTranscriptEvent {
    session_id: String,
    stream_id: String,
    source: AudioSourceKind,
    provider_sequence: Option<i32>,
    provider_utterance_id: Option<String>,
    revision_of: Option<String>,
    text: String,
    start_ms: u64,
    end_ms: u64,
    speaker: String,
    confidence: Option<f64>,
    state: String,
    definite: bool,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrDiagnosticEvent {
    session_id: String,
    stream_id: Option<String>,
    source: Option<AudioSourceKind>,
    level: String,
    category: String,
    message: String,
    error_code: Option<String>,
    service_log_id: Option<String>,
    retry_attempt: Option<u32>,
    created_at: i64,
}

#[derive(Debug, PartialEq)]
pub enum ParsedAsrFrame {
    ServerResponse {
        sequence: i32,
        payload: Value,
        is_final: bool,
    },
    Error {
        code: u32,
        message: String,
    },
}

#[tauri::command]
pub async fn interview_asr_start_session(
    app: AppHandle,
    state: State<'_, InterviewAsrState>,
    request: InterviewAsrStartSessionRequest,
) -> Result<InterviewAsrStartSessionResponse, String> {
    validate_start_request(&request)?;
    let request_id = request
        .request_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let session_key = session_key(&request.session_id, &request.stream_id);
    emit_status(
        &app,
        &request.session_id,
        Some(&request.stream_id),
        Some(request.source.clone()),
        "connecting",
        "info",
        "ASR stream connecting",
        None,
        None,
        None,
    );

    let ws_request = build_websocket_request(&request, &request_id)?;
    let (ws_stream, response) = connect_async(ws_request).await.map_err(|error| {
        let redacted = format_websocket_connect_error(&error.to_string(), &request.api_key);
        emit_diagnostic(
            &app,
            &request.session_id,
            Some(&request.stream_id),
            Some(request.source.clone()),
            "error",
            "connectivity",
            &format!("ASR WebSocket connection failed: {redacted}"),
            Some("connect_failed"),
            None,
            None,
        );
        format!("ASR WebSocket connection failed: {redacted}")
    })?;

    let service_log_id = response
        .headers()
        .get("X-Tt-Logid")
        .or_else(|| response.headers().get("x-tt-logid"))
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    let (mut write, mut read) = ws_stream.split();
    let full_request = build_full_client_request_payload(&request);
    let full_frame = build_full_client_request_frame(&full_request)?;
    write
        .send(Message::Binary(full_frame.into()))
        .await
        .map_err(|error| {
            format!(
                "ASR full request failed: {}",
                redact_credentials(&error.to_string(), &request.api_key)
            )
        })?;

    let (sender, mut receiver) = mpsc::channel::<AsrOutbound>(64);
    let writer_app = app.clone();
    let writer_session_id = request.session_id.clone();
    let writer_stream_id = request.stream_id.clone();
    let writer_source = request.source.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(outbound) = receiver.recv().await {
            match outbound {
                AsrOutbound::Audio {
                    sequence,
                    pcm16,
                    is_final,
                } => {
                    if is_final {
                        emit_status(
                            &writer_app,
                            &writer_session_id,
                            Some(&writer_stream_id),
                            Some(writer_source.clone()),
                            "finalizing",
                            "info",
                            "ASR stream finalizing",
                            None,
                            None,
                            None,
                        );
                    }
                    match build_audio_only_request_frame(&pcm16, sequence, is_final) {
                        Ok(frame) => {
                            if let Err(error) = write.send(Message::Binary(frame.into())).await {
                                emit_diagnostic(
                                    &writer_app,
                                    &writer_session_id,
                                    Some(&writer_stream_id),
                                    Some(writer_source.clone()),
                                    "error",
                                    "connectivity",
                                    &format!("ASR audio send failed: {error}"),
                                    Some("send_failed"),
                                    None,
                                    None,
                                );
                                break;
                            }
                        }
                        Err(error) => {
                            emit_diagnostic(
                                &writer_app,
                                &writer_session_id,
                                Some(&writer_stream_id),
                                Some(writer_source.clone()),
                                "error",
                                "protocol",
                                &error,
                                Some("frame_build_failed"),
                                None,
                                None,
                            );
                        }
                    }
                }
                AsrOutbound::Stop { reason } => {
                    let _ = write.close().await;
                    emit_status(
                        &writer_app,
                        &writer_session_id,
                        Some(&writer_stream_id),
                        Some(writer_source.clone()),
                        "stopped",
                        "info",
                        &format!("ASR stream stopped: {reason:?}"),
                        None,
                        None,
                        None,
                    );
                    break;
                }
            }
        }
    });

    let reader_app = app.clone();
    let reader_session_id = request.session_id.clone();
    let reader_stream_id = request.stream_id.clone();
    let reader_source = request.source.clone();
    let reader_service_log_id = service_log_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(message) = read.next().await {
            match message {
                Ok(Message::Binary(bytes)) => {
                    handle_server_frame(
                        &reader_app,
                        &reader_session_id,
                        &reader_stream_id,
                        reader_source.clone(),
                        reader_service_log_id.clone(),
                        bytes.as_ref(),
                    );
                }
                Ok(Message::Close(_)) => {
                    emit_status(
                        &reader_app,
                        &reader_session_id,
                        Some(&reader_stream_id),
                        Some(reader_source.clone()),
                        "stopped",
                        "info",
                        "ASR stream closed",
                        None,
                        reader_service_log_id.clone(),
                        None,
                    );
                    break;
                }
                Ok(_) => {}
                Err(error) => {
                    emit_status(
                        &reader_app,
                        &reader_session_id,
                        Some(&reader_stream_id),
                        Some(reader_source.clone()),
                        "retrying",
                        "warn",
                        &format!("ASR stream interrupted: {error}"),
                        Some(1),
                        reader_service_log_id.clone(),
                        Some("stream_interrupted"),
                    );
                    emit_diagnostic(
                        &reader_app,
                        &reader_session_id,
                        Some(&reader_stream_id),
                        Some(reader_source.clone()),
                        "warn",
                        "retry",
                        &format!("ASR stream requires retry: {error}"),
                        Some("stream_interrupted"),
                        reader_service_log_id.clone(),
                        Some(1),
                    );
                    break;
                }
            }
        }
    });

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "ASR session state is unavailable".to_string())?;
        sessions.insert(
            session_key,
            AsrSessionHandle {
                sender,
                source: request.source.clone(),
            },
        );
    }

    emit_status(
        &app,
        &request.session_id,
        Some(&request.stream_id),
        Some(request.source.clone()),
        "listening",
        "info",
        "ASR stream listening",
        None,
        service_log_id.clone(),
        None,
    );

    Ok(InterviewAsrStartSessionResponse {
        session_id: request.session_id,
        stream_id: request.stream_id,
        request_id,
        status: "listening".to_string(),
        service_log_id,
    })
}

#[tauri::command]
pub async fn interview_asr_push_audio(
    state: State<'_, InterviewAsrState>,
    request: InterviewAsrPushAudioRequest,
) -> Result<InterviewAsrPushAudioResponse, String> {
    validate_pcm16_payload(&request.pcm16)?;
    let sender = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "ASR session state is unavailable".to_string())?;
        sessions
            .get(&session_key(&request.session_id, &request.stream_id))
            .map(|handle| handle.sender.clone())
    };
    let sender = sender.ok_or_else(|| {
        format!(
            "ASR stream is not active: {}/{}",
            request.session_id, request.stream_id
        )
    })?;
    sender
        .send(AsrOutbound::Audio {
            sequence: request.sequence,
            pcm16: request.pcm16,
            is_final: request.is_final,
        })
        .await
        .map_err(|_| "ASR stream is no longer accepting audio.".to_string())?;
    Ok(InterviewAsrPushAudioResponse {
        accepted: true,
        session_id: request.session_id,
        stream_id: request.stream_id,
        sequence: request.sequence,
    })
}

#[tauri::command]
pub async fn interview_asr_stop_session(
    app: AppHandle,
    state: State<'_, InterviewAsrState>,
    request: InterviewAsrStopSessionRequest,
) -> Result<InterviewAsrStopSessionResponse, String> {
    let removed = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "ASR session state is unavailable".to_string())?;
        sessions.remove(&session_key(&request.session_id, &request.stream_id))
    };
    if let Some(handle) = removed {
        let _ = handle
            .sender
            .send(AsrOutbound::Stop {
                reason: request.reason.clone(),
            })
            .await;
        emit_status(
            &app,
            &request.session_id,
            Some(&request.stream_id),
            Some(handle.source),
            "stopped",
            "info",
            "ASR stream stopped",
            None,
            None,
            None,
        );
    }
    Ok(InterviewAsrStopSessionResponse {
        session_id: request.session_id,
        stream_id: request.stream_id,
        status: "stopped".to_string(),
    })
}

pub fn build_full_client_request_payload(request: &InterviewAsrStartSessionRequest) -> Value {
    let mut request_body = json!({
        "user": {
            "uid": request.session_id,
            "platform": "tauri-desktop",
            "sdk_version": "llm-wiki"
        },
        "audio": {
            "format": request.audio.format,
            "codec": request.audio.codec,
            "rate": request.audio.rate,
            "bits": request.audio.bits,
            "channel": request.audio.channel
        },
        "request": {
            "model_name": request.request.model_name,
            "enable_nonstream": request.request.enable_nonstream,
            "show_utterances": request.request.show_utterances,
            "result_type": request.request.result_type,
            "end_window_size": request.request.end_window_size_ms,
            "force_to_speech_time": request.request.force_to_speech_time_ms
        }
    });
    if request.request.enable_speaker_info.unwrap_or(false) {
        request_body["request"]["enable_speaker_info"] = Value::Bool(true);
        request_body["request"]["ssd_version"] = Value::String("200".to_string());
    }
    request_body
}

pub fn build_full_client_request_frame(payload: &Value) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    build_frame(
        MESSAGE_TYPE_FULL_CLIENT_REQUEST,
        FLAG_NO_SEQUENCE,
        SERIALIZATION_JSON,
        COMPRESSION_GZIP,
        None,
        &bytes,
    )
}

pub fn build_audio_only_request_frame(
    pcm16: &[u8],
    _sequence: i32,
    is_final: bool,
) -> Result<Vec<u8>, String> {
    validate_pcm16_payload(pcm16)?;
    build_frame(
        MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
        if is_final {
            FLAG_FINAL_NO_SEQUENCE
        } else {
            FLAG_NO_SEQUENCE
        },
        SERIALIZATION_NONE,
        COMPRESSION_GZIP,
        None,
        pcm16,
    )
}

fn build_frame(
    message_type: u8,
    flags: u8,
    serialization: u8,
    compression: u8,
    sequence: Option<i32>,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    let payload = if compression == COMPRESSION_GZIP {
        gzip_compress(payload)?
    } else {
        payload.to_vec()
    };
    let mut frame = Vec::with_capacity(4 + sequence.map(|_| 4).unwrap_or(0) + 4 + payload.len());
    frame.push((HEADER_VERSION << 4) | HEADER_SIZE_WORDS);
    frame.push((message_type << 4) | flags);
    frame.push((serialization << 4) | compression);
    frame.push(0);
    if let Some(sequence) = sequence {
        frame.extend_from_slice(&sequence.to_be_bytes());
    }
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn parse_asr_frame(frame: &[u8]) -> Result<ParsedAsrFrame, String> {
    if frame.len() < 8 {
        return Err("ASR frame is too short.".to_string());
    }
    let header_size = usize::from(frame[0] & 0x0f) * 4;
    if frame.len() < header_size {
        return Err("ASR frame header is incomplete.".to_string());
    }
    let message_type = frame[1] >> 4;
    let flags = frame[1] & 0x0f;
    let compression = frame[2] & 0x0f;
    match message_type {
        MESSAGE_TYPE_FULL_SERVER_RESPONSE => {
            if frame.len() < header_size + 8 {
                return Err("ASR server response is incomplete.".to_string());
            }
            let sequence =
                i32::from_be_bytes(frame[header_size..header_size + 4].try_into().unwrap());
            let payload_size =
                u32::from_be_bytes(frame[header_size + 4..header_size + 8].try_into().unwrap())
                    as usize;
            let payload_start = header_size + 8;
            let payload_end = payload_start + payload_size;
            if frame.len() < payload_end {
                return Err("ASR server response payload is incomplete.".to_string());
            }
            let payload = decode_payload(&frame[payload_start..payload_end], compression)?;
            let json = serde_json::from_slice(&payload).map_err(|error| error.to_string())?;
            Ok(ParsedAsrFrame::ServerResponse {
                sequence,
                payload: json,
                is_final: flags == 0x3,
            })
        }
        MESSAGE_TYPE_ERROR => {
            if frame.len() < header_size + 8 {
                return Err("ASR error frame is incomplete.".to_string());
            }
            let code = u32::from_be_bytes(frame[header_size..header_size + 4].try_into().unwrap());
            let payload_size =
                u32::from_be_bytes(frame[header_size + 4..header_size + 8].try_into().unwrap())
                    as usize;
            let payload_start = header_size + 8;
            let payload_end = payload_start + payload_size;
            if frame.len() < payload_end {
                return Err("ASR error payload is incomplete.".to_string());
            }
            let payload = decode_payload(&frame[payload_start..payload_end], compression)?;
            let message = String::from_utf8_lossy(&payload).to_string();
            Ok(ParsedAsrFrame::Error { code, message })
        }
        other => Err(format!("Unsupported ASR frame type: {other}")),
    }
}

pub fn redact_credentials(message: &str, api_key: &str) -> String {
    let mut redacted = message.to_string();
    if !api_key.trim().is_empty() {
        redacted = redacted.replace(api_key, "[REDACTED]");
    }
    redacted
        .replace("X-Api-Key", "X-Api-Key=[REDACTED]")
        .replace("Authorization", "Authorization=[REDACTED]")
}

fn format_websocket_connect_error(message: &str, api_key: &str) -> String {
    let redacted = redact_credentials(message, api_key);
    if redacted.contains("401 Unauthorized") {
        return format!(
            "{redacted}. Check Settings -> ASR transcription: use the Volcengine Speech console X-Api-Key, not an LLM key or AK/SK pair, and make sure Resource ID matches the enabled ASR resource."
        );
    }
    redacted
}

fn handle_server_frame(
    app: &AppHandle,
    session_id: &str,
    stream_id: &str,
    source: AudioSourceKind,
    service_log_id: Option<String>,
    bytes: &[u8],
) {
    match parse_asr_frame(bytes) {
        Ok(ParsedAsrFrame::ServerResponse {
            sequence,
            payload,
            is_final: _,
        }) => {
            for event in transcript_events_from_payload(
                session_id,
                stream_id,
                source.clone(),
                sequence,
                &payload,
            ) {
                let _ = app.emit(EVENT_TRANSCRIPT, event);
            }
        }
        Ok(ParsedAsrFrame::Error { code, message }) => {
            emit_status(
                app,
                session_id,
                Some(stream_id),
                Some(source.clone()),
                "failed",
                "error",
                &format!("ASR service error: {message}"),
                None,
                service_log_id.clone(),
                Some(&code.to_string()),
            );
            emit_diagnostic(
                app,
                session_id,
                Some(stream_id),
                Some(source),
                "error",
                "service",
                &message,
                Some(&code.to_string()),
                service_log_id,
                None,
            );
        }
        Err(error) => {
            emit_diagnostic(
                app,
                session_id,
                Some(stream_id),
                Some(source),
                "error",
                "protocol",
                &error,
                Some("parse_failed"),
                service_log_id,
                None,
            );
        }
    }
}

fn transcript_events_from_payload(
    session_id: &str,
    stream_id: &str,
    source: AudioSourceKind,
    sequence: i32,
    payload: &Value,
) -> Vec<AsrTranscriptEvent> {
    let result = payload.get("result").unwrap_or(payload);
    let created_at = now_ms();
    let mut events = Vec::new();
    if let Some(utterances) = result.get("utterances").and_then(Value::as_array) {
        for (index, utterance) in utterances.iter().enumerate() {
            let text = utterance
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                continue;
            }
            let definite = utterance
                .get("definite")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let start_ms = value_to_u64(utterance.get("start_time")).unwrap_or(0);
            let end_ms = value_to_u64(utterance.get("end_time")).unwrap_or(start_ms);
            let utterance_id = utterance
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("{stream_id}-{sequence}-{start_ms}-{index}"));
            events.push(AsrTranscriptEvent {
                session_id: session_id.to_string(),
                stream_id: stream_id.to_string(),
                source: source.clone(),
                provider_sequence: Some(sequence),
                provider_utterance_id: Some(utterance_id),
                revision_of: None,
                text: text.to_string(),
                start_ms,
                end_ms,
                speaker: speaker_from_utterance(utterance, &source),
                confidence: utterance.get("confidence").and_then(Value::as_f64),
                state: if definite { "confirmed" } else { "provisional" }.to_string(),
                definite,
                created_at,
            });
        }
    } else if let Some(text) = result.get("text").and_then(Value::as_str).map(str::trim) {
        if !text.is_empty() {
            events.push(AsrTranscriptEvent {
                session_id: session_id.to_string(),
                stream_id: stream_id.to_string(),
                source: source.clone(),
                provider_sequence: Some(sequence),
                provider_utterance_id: Some(format!("{stream_id}-{sequence}")),
                revision_of: None,
                text: text.to_string(),
                start_ms: 0,
                end_ms: 0,
                speaker: speaker_from_source(&source),
                confidence: None,
                state: "provisional".to_string(),
                definite: false,
                created_at,
            });
        }
    }
    events
}

fn speaker_from_utterance(utterance: &Value, source: &AudioSourceKind) -> String {
    if let Some(speaker) = utterance
        .get("speaker")
        .or_else(|| utterance.get("speaker_id"))
        .and_then(Value::as_str)
    {
        let lower = speaker.to_lowercase();
        if lower.contains("interviewer") || lower.contains("面试官") {
            return "interviewer".to_string();
        }
        if lower.contains("candidate")
            || lower.contains("interviewee")
            || lower.contains("候选人")
            || lower.contains("应聘者")
        {
            return "interviewee".to_string();
        }
    }
    speaker_from_source(source)
}

fn speaker_from_source(source: &AudioSourceKind) -> String {
    match source {
        AudioSourceKind::System => "interviewer",
        AudioSourceKind::Microphone => "interviewee",
        AudioSourceKind::File => "unknown",
    }
    .to_string()
}

fn build_websocket_request(
    request: &InterviewAsrStartSessionRequest,
    request_id: &str,
) -> Result<WsClientRequest, String> {
    let endpoint = normalize_websocket_endpoint(request.endpoint.trim())?;
    let mut ws_request = endpoint
        .as_str()
        .into_client_request()
        .map_err(|error| format!("Invalid ASR WebSocket request: {error}"))?;
    let headers = ws_request.headers_mut();
    insert_ws_header(headers, "X-Api-Key", request.api_key.trim())?;
    insert_ws_header(headers, "X-Api-Resource-Id", request.resource_id.trim())?;
    insert_ws_header(headers, "X-Api-Request-Id", request_id)?;
    insert_ws_header(headers, "X-Api-Connect-Id", request_id)?;
    insert_ws_header(headers, "X-Api-Sequence", "-1")?;
    Ok(ws_request)
}

fn normalize_websocket_endpoint(endpoint: &str) -> Result<String, String> {
    let mut parsed =
        url::Url::parse(endpoint).map_err(|error| format!("Invalid ASR endpoint: {error}"))?;
    match parsed.scheme() {
        "ws" | "wss" => {}
        "http" => {
            parsed.set_scheme("ws").map_err(|_| {
                "Invalid ASR endpoint: cannot convert http endpoint to ws".to_string()
            })?;
        }
        "https" => {
            parsed.set_scheme("wss").map_err(|_| {
                "Invalid ASR endpoint: cannot convert https endpoint to wss".to_string()
            })?;
        }
        scheme => {
            return Err(format!(
                "ASR WebSocket endpoint must use ws:// or wss://, got {scheme}://"
            ));
        }
    }
    Ok(parsed.to_string())
}

fn insert_ws_header(
    headers: &mut HeaderMap,
    name: &'static str,
    value: &str,
) -> Result<(), String> {
    let value = HeaderValue::from_str(value)
        .map_err(|_| format!("Invalid ASR WebSocket {name} header value"))?;
    headers.insert(name, value);
    Ok(())
}

fn validate_start_request(request: &InterviewAsrStartSessionRequest) -> Result<(), String> {
    if request.session_id.trim().is_empty() {
        return Err("ASR session id is required.".to_string());
    }
    if request.stream_id.trim().is_empty() {
        return Err("ASR stream id is required.".to_string());
    }
    if request.endpoint.trim().is_empty() {
        return Err("ASR endpoint is required.".to_string());
    }
    if request.resource_id.trim().is_empty() {
        return Err("ASR resource ID is required.".to_string());
    }
    if request.api_key.trim().is_empty() {
        return Err("ASR API key is required.".to_string());
    }
    if request.audio.format != "pcm"
        || request.audio.codec != "raw"
        || request.audio.rate != 16_000
        || request.audio.bits != 16
        || request.audio.channel != 1
    {
        return Err("ASR audio must be PCM16 raw mono at 16 kHz.".to_string());
    }
    if request.request.model_name != "bigmodel" {
        return Err("ASR model_name must be bigmodel.".to_string());
    }
    Ok(())
}

fn validate_pcm16_payload(pcm16: &[u8]) -> Result<(), String> {
    if pcm16.is_empty() {
        return Err("ASR audio payload cannot be empty.".to_string());
    }
    if pcm16.len() % 2 != 0 {
        return Err("ASR audio payload must contain whole PCM16 samples.".to_string());
    }
    Ok(())
}

fn decode_payload(payload: &[u8], compression: u8) -> Result<Vec<u8>, String> {
    if compression == COMPRESSION_GZIP {
        gzip_decompress(payload)
    } else if compression == COMPRESSION_NONE {
        Ok(payload.to_vec())
    } else {
        Err(format!("Unsupported ASR compression: {compression}"))
    }
}

fn gzip_compress(payload: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(payload)
        .map_err(|error| error.to_string())?;
    encoder.finish().map_err(|error| error.to_string())
}

fn gzip_decompress(payload: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = GzDecoder::new(payload);
    let mut decoded = Vec::new();
    decoder
        .read_to_end(&mut decoded)
        .map_err(|error| error.to_string())?;
    Ok(decoded)
}

fn emit_status(
    app: &AppHandle,
    session_id: &str,
    stream_id: Option<&str>,
    source: Option<AudioSourceKind>,
    status: &str,
    level: &str,
    message: &str,
    retry_attempt: Option<u32>,
    service_log_id: Option<String>,
    error_code: Option<&str>,
) {
    let _ = app.emit(
        EVENT_STATUS,
        AsrStatusEvent {
            session_id: session_id.to_string(),
            stream_id: stream_id.map(ToOwned::to_owned),
            source,
            status: status.to_string(),
            level: level.to_string(),
            message: message.to_string(),
            retry_attempt,
            service_log_id,
            error_code: error_code.map(ToOwned::to_owned),
            created_at: now_ms(),
        },
    );
}

fn emit_diagnostic(
    app: &AppHandle,
    session_id: &str,
    stream_id: Option<&str>,
    source: Option<AudioSourceKind>,
    level: &str,
    category: &str,
    message: &str,
    error_code: Option<&str>,
    service_log_id: Option<String>,
    retry_attempt: Option<u32>,
) {
    let _ = app.emit(
        EVENT_DIAGNOSTIC,
        AsrDiagnosticEvent {
            session_id: session_id.to_string(),
            stream_id: stream_id.map(ToOwned::to_owned),
            source,
            level: level.to_string(),
            category: category.to_string(),
            message: message.to_string(),
            error_code: error_code.map(ToOwned::to_owned),
            service_log_id,
            retry_attempt,
            created_at: now_ms(),
        },
    );
}

fn value_to_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).or_else(|| {
        value
            .and_then(Value::as_i64)
            .and_then(|value| u64::try_from(value).ok())
    })
}

fn session_key(session_id: &str, stream_id: &str) -> String {
    format!("{session_id}:{stream_id}")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start_request() -> InterviewAsrStartSessionRequest {
        InterviewAsrStartSessionRequest {
            session_id: "session-1".to_string(),
            stream_id: "stream-system".to_string(),
            source: AudioSourceKind::System,
            endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async".to_string(),
            resource_id: "volc.bigasr.sauc.duration".to_string(),
            api_key: "secret-key".to_string(),
            request_id: Some("request-1".to_string()),
            audio: InterviewAsrAudioConfig {
                format: "pcm".to_string(),
                codec: "raw".to_string(),
                rate: 16_000,
                bits: 16,
                channel: 1,
            },
            request: InterviewAsrRequestConfig {
                model_name: "bigmodel".to_string(),
                enable_nonstream: true,
                show_utterances: true,
                result_type: "single".to_string(),
                end_window_size_ms: 800,
                force_to_speech_time_ms: 1000,
                enable_speaker_info: Some(true),
            },
        }
    }

    #[test]
    fn builds_full_request_frame_with_gzip_json_payload() {
        let payload = build_full_client_request_payload(&start_request());
        let frame = build_full_client_request_frame(&payload).unwrap();

        assert_eq!(frame[0], 0x11);
        assert_eq!(frame[1], 0x10);
        assert_eq!(frame[2], 0x11);
        let payload_size = u32::from_be_bytes(frame[4..8].try_into().unwrap()) as usize;
        assert_eq!(payload_size, frame.len() - 8);
        let decoded = gzip_decompress(&frame[8..]).unwrap();
        let json: Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(json["audio"]["format"], "pcm");
        assert_eq!(json["audio"]["rate"], 16_000);
        assert_eq!(json["request"]["model_name"], "bigmodel");
        assert_eq!(json["request"]["enable_nonstream"], true);
        assert_eq!(json["request"]["show_utterances"], true);
        assert_eq!(json["request"]["result_type"], "single");
        assert_eq!(json["request"]["ssd_version"], "200");
    }

    #[test]
    fn builds_audio_frame_with_sequence_and_final_flag() {
        let frame = build_audio_only_request_frame(&[1, 0, 2, 0], 7, false).unwrap();

        assert_eq!(frame[0], 0x11);
        assert_eq!(frame[1], 0x20);
        assert_eq!(frame[2], 0x01);
        let payload_size = u32::from_be_bytes(frame[4..8].try_into().unwrap()) as usize;
        assert_eq!(payload_size, frame.len() - 8);
        assert_eq!(gzip_decompress(&frame[8..]).unwrap(), vec![1, 0, 2, 0]);

        let final_frame = build_audio_only_request_frame(&[1, 0], 8, true).unwrap();
        assert_eq!(final_frame[1], 0x22);
        let final_payload_size = u32::from_be_bytes(final_frame[4..8].try_into().unwrap()) as usize;
        assert_eq!(final_payload_size, final_frame.len() - 8);
    }

    #[test]
    fn builds_websocket_request_with_standard_upgrade_and_volcengine_headers() {
        let request = build_websocket_request(&start_request(), "request-1").unwrap();

        assert_eq!(request.uri().scheme_str(), Some("wss"));
        assert_eq!(
            request
                .headers()
                .get("Connection")
                .and_then(|value| value.to_str().ok()),
            Some("Upgrade"),
        );
        assert_eq!(
            request
                .headers()
                .get("Upgrade")
                .and_then(|value| value.to_str().ok()),
            Some("websocket"),
        );
        assert!(request.headers().get("Sec-WebSocket-Key").is_some());
        assert_eq!(
            request
                .headers()
                .get("X-Api-Key")
                .and_then(|value| value.to_str().ok()),
            Some("secret-key"),
        );
        assert_eq!(
            request
                .headers()
                .get("X-Api-Resource-Id")
                .and_then(|value| value.to_str().ok()),
            Some("volc.bigasr.sauc.duration"),
        );
        assert_eq!(
            request
                .headers()
                .get("X-Api-Request-Id")
                .and_then(|value| value.to_str().ok()),
            Some("request-1"),
        );
        assert_eq!(
            request
                .headers()
                .get("X-Api-Connect-Id")
                .and_then(|value| value.to_str().ok()),
            Some("request-1"),
        );
        assert_eq!(
            request
                .headers()
                .get("X-Api-Sequence")
                .and_then(|value| value.to_str().ok()),
            Some("-1"),
        );
    }

    #[test]
    fn normalizes_http_websocket_endpoint_schemes_before_connecting() {
        let mut request = start_request();
        request.endpoint =
            "https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async".to_string();

        let websocket_request = build_websocket_request(&request, "request-1").unwrap();

        assert_eq!(websocket_request.uri().scheme_str(), Some("wss"));
        assert_eq!(
            websocket_request.uri().to_string(),
            "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
        );
    }

    #[test]
    fn rejects_non_websocket_endpoint_schemes_with_clear_error() {
        let mut request = start_request();
        request.endpoint = "ftp://openspeech.bytedance.com/api/v3/sauc/bigmodel_async".to_string();

        let error = build_websocket_request(&request, "request-1").unwrap_err();

        assert_eq!(
            error,
            "ASR WebSocket endpoint must use ws:// or wss://, got ftp://",
        );
    }

    #[test]
    fn parses_server_response_and_error_frames() {
        let response = json!({
            "result": {
                "utterances": [{
                    "text": "请介绍一个项目。",
                    "start_time": 0,
                    "end_time": 1200,
                    "definite": true
                }]
            }
        });
        let response_frame = build_frame(
            MESSAGE_TYPE_FULL_SERVER_RESPONSE,
            0x3,
            SERIALIZATION_JSON,
            COMPRESSION_GZIP,
            Some(3),
            &serde_json::to_vec(&response).unwrap(),
        )
        .unwrap();
        assert_eq!(
            parse_asr_frame(&response_frame).unwrap(),
            ParsedAsrFrame::ServerResponse {
                sequence: 3,
                payload: response,
                is_final: true,
            }
        );

        let error_frame = build_frame(
            MESSAGE_TYPE_ERROR,
            FLAG_NO_SEQUENCE,
            SERIALIZATION_JSON,
            COMPRESSION_NONE,
            Some(45_000_001),
            br#"{"message":"bad request"}"#,
        )
        .unwrap();
        assert_eq!(
            parse_asr_frame(&error_frame).unwrap(),
            ParsedAsrFrame::Error {
                code: 45_000_001,
                message: r#"{"message":"bad request"}"#.to_string(),
            }
        );
    }

    #[test]
    fn maps_definite_utterances_to_confirmed_events() {
        let payload = json!({
            "result": {
                "utterances": [
                    { "text": "临时文本", "start_time": 0, "end_time": 500, "definite": false },
                    { "text": "请讲一下缓存策略？", "start_time": 600, "end_time": 1800, "definite": true }
                ]
            }
        });

        let events = transcript_events_from_payload(
            "session-1",
            "stream-system",
            AudioSourceKind::System,
            2,
            &payload,
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].state, "provisional");
        assert!(!events[0].definite);
        assert_eq!(events[1].state, "confirmed");
        assert!(events[1].definite);
        assert_eq!(events[1].speaker, "interviewer");
    }

    #[test]
    fn redacts_api_key_from_errors() {
        assert_eq!(
            redact_credentials("failed with secret-key in header X-Api-Key", "secret-key"),
            "failed with [REDACTED] in header X-Api-Key=[REDACTED]",
        );
    }

    #[test]
    fn explains_unauthorized_websocket_errors_without_leaking_credentials() {
        let message = format_websocket_connect_error(
            "HTTP error: 401 Unauthorized for secret-key",
            "secret-key",
        );

        assert!(message.contains("401 Unauthorized"));
        assert!(message.contains("Volcengine Speech console X-Api-Key"));
        assert!(message.contains("Resource ID"));
        assert!(!message.contains("secret-key"));
    }
}
