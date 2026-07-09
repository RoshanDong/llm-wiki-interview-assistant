use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const AUDIO_CHUNK_EVENT: &str = "interview-audio://chunk";
const AUDIO_STATUS_EVENT: &str = "interview-audio://status";
const OUTPUT_SAMPLE_RATE: u32 = 16_000;

#[derive(Default)]
pub struct InterviewAudioState {
    captures: Mutex<HashMap<String, CaptureHandle>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioStartRequest {
    capture_id: String,
    source: String,
    label: String,
    packet_ms: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioStopRequest {
    capture_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeAudioSource {
    System,
    Microphone,
}

impl NativeAudioSource {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "system" => Ok(Self::System),
            "microphone" => Ok(Self::Microphone),
            other => Err(format!("Unsupported native audio source: {other}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Microphone => "microphone",
        }
    }
}

struct CaptureHandle {
    source: NativeAudioSource,
    backend: CaptureBackend,
}

enum CaptureBackend {
    Microphone(MicrophoneCapture),
    #[cfg(target_os = "macos")]
    System(SystemCapture),
}

struct MicrophoneCapture {
    _stream: Stream,
}

#[cfg(target_os = "macos")]
struct SystemCapture {
    stream: screencapturekit::prelude::SCStream,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioChunkEvent {
    capture_id: String,
    source: String,
    sequence: u32,
    pcm16: Vec<u8>,
    sample_rate: u32,
    channel_count: u16,
    duration_ms: u32,
    is_final: bool,
    created_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioStatusEvent {
    capture_id: String,
    source: String,
    status: String,
    message: String,
    created_at: u64,
}

struct Pcm16Packetizer {
    app: AppHandle,
    capture_id: String,
    source: NativeAudioSource,
    pending: Vec<i16>,
    packet_samples: usize,
    sequence: u32,
}

impl Pcm16Packetizer {
    fn new(app: AppHandle, capture_id: String, source: NativeAudioSource, packet_ms: u32) -> Self {
        let packet_samples = ((OUTPUT_SAMPLE_RATE as usize) * packet_ms as usize / 1000).max(1);
        Self {
            app,
            capture_id,
            source,
            pending: Vec::with_capacity(packet_samples * 2),
            packet_samples,
            sequence: 1,
        }
    }

    fn push(&mut self, samples: &[i16]) {
        self.pending.extend_from_slice(samples);
        while self.pending.len() >= self.packet_samples {
            let packet: Vec<i16> = self.pending.drain(..self.packet_samples).collect();
            self.emit_packet(packet, false);
        }
    }

    fn emit_packet(&mut self, samples: Vec<i16>, is_final: bool) {
        if samples.is_empty() {
            return;
        }
        let mut pcm16 = Vec::with_capacity(samples.len() * 2);
        for sample in &samples {
            pcm16.extend_from_slice(&sample.to_le_bytes());
        }
        let event = NativeAudioChunkEvent {
            capture_id: self.capture_id.clone(),
            source: self.source.as_str().to_string(),
            sequence: self.sequence,
            pcm16,
            sample_rate: OUTPUT_SAMPLE_RATE,
            channel_count: 1,
            duration_ms: duration_ms_for_samples(samples.len()),
            is_final,
            created_at: now_ms(),
        };
        self.sequence = self.sequence.saturating_add(1);
        let _ = self.app.emit(AUDIO_CHUNK_EVENT, event);
    }
}

#[tauri::command]
pub fn interview_audio_start_capture(
    app: AppHandle,
    state: State<'_, InterviewAudioState>,
    request: NativeAudioStartRequest,
) -> Result<(), String> {
    let source = NativeAudioSource::parse(&request.source)?;
    let packet_ms = clamp_packet_ms(request.packet_ms);
    if request.capture_id.trim().is_empty() {
        return Err("Native audio capture ID cannot be empty.".to_string());
    }

    {
        let captures = state
            .captures
            .lock()
            .map_err(|_| "Native audio capture state is unavailable.".to_string())?;
        if captures.contains_key(&request.capture_id) {
            return Err(format!(
                "Native audio capture is already running: {}",
                request.capture_id
            ));
        }
    }

    let handle = match source {
        NativeAudioSource::Microphone => {
            start_microphone_capture(&app, &request.capture_id, packet_ms)?
        }
        NativeAudioSource::System => start_system_capture(&app, &request, packet_ms)?,
    };

    let mut captures = state
        .captures
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_string())?;
    captures.insert(
        request.capture_id.clone(),
        CaptureHandle {
            source,
            backend: handle,
        },
    );
    drop(captures);

    emit_status(
        &app,
        &request.capture_id,
        source,
        "started",
        &format!(
            "Native {} capture started: {}.",
            source.as_str(),
            request.label.trim()
        ),
    );
    Ok(())
}

#[tauri::command]
pub fn interview_audio_stop_capture(
    app: AppHandle,
    state: State<'_, InterviewAudioState>,
    request: NativeAudioStopRequest,
) -> Result<(), String> {
    let handle = {
        let mut captures = state
            .captures
            .lock()
            .map_err(|_| "Native audio capture state is unavailable.".to_string())?;
        captures.remove(&request.capture_id)
    };

    if let Some(mut handle) = handle {
        stop_capture_backend(&mut handle.backend)?;
        emit_status(
            &app,
            &request.capture_id,
            handle.source,
            "stopped",
            &format!("Native {} capture stopped.", handle.source.as_str()),
        );
    }
    Ok(())
}

pub fn validate_system_audio_label(label: &str) -> Result<String, String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err("System audio label cannot be empty".to_string());
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
pub fn interview_audio_start_system_capture(label: String) -> Result<String, String> {
    let label = validate_system_audio_label(&label)?;
    Ok(format!("system-audio-boundary-started:{label}"))
}

#[tauri::command]
pub fn interview_audio_stop_system_capture() -> Result<String, String> {
    Ok("system-audio-boundary-stopped".to_string())
}

fn start_microphone_capture(
    app: &AppHandle,
    capture_id: &str,
    packet_ms: u32,
) -> Result<CaptureBackend, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "No default microphone input device is available.".to_string())?;
    let supported_config = device
        .default_input_config()
        .map_err(|err| format!("Failed to read default microphone config: {err}"))?;
    let sample_format = supported_config.sample_format();
    let sample_rate = supported_config.sample_rate();
    let channels = usize::from(supported_config.channels()).max(1);
    let stream_config = supported_config.into();
    let packetizer = Arc::new(Mutex::new(Pcm16Packetizer::new(
        app.clone(),
        capture_id.to_string(),
        NativeAudioSource::Microphone,
        packet_ms,
    )));
    let err_app = app.clone();
    let err_capture_id = capture_id.to_string();
    let err_fn = move |err| {
        emit_status(
            &err_app,
            &err_capture_id,
            NativeAudioSource::Microphone,
            "failed",
            &format!("Microphone capture failed: {err}"),
        );
    };

    let stream = match sample_format {
        SampleFormat::F32 => build_input_stream(
            &device,
            &stream_config,
            channels,
            sample_rate,
            packetizer,
            |sample: f32| sample,
            err_fn,
        ),
        SampleFormat::F64 => build_input_stream(
            &device,
            &stream_config,
            channels,
            sample_rate,
            packetizer,
            |sample: f64| sample as f32,
            err_fn,
        ),
        SampleFormat::I8 => build_input_stream(
            &device,
            &stream_config,
            channels,
            sample_rate,
            packetizer,
            |sample: i8| sample as f32 / i8::MAX as f32,
            err_fn,
        ),
        SampleFormat::I16 => build_input_stream(
            &device,
            &stream_config,
            channels,
            sample_rate,
            packetizer,
            |sample: i16| sample as f32 / i16::MAX as f32,
            err_fn,
        ),
        SampleFormat::I32 => build_input_stream(
            &device,
            &stream_config,
            channels,
            sample_rate,
            packetizer,
            |sample: i32| sample as f32 / i32::MAX as f32,
            err_fn,
        ),
        SampleFormat::U8 => build_input_stream(
            &device,
            &stream_config,
            channels,
            sample_rate,
            packetizer,
            |sample: u8| (sample as f32 - 128.0) / 128.0,
            err_fn,
        ),
        SampleFormat::U16 => build_input_stream(
            &device,
            &stream_config,
            channels,
            sample_rate,
            packetizer,
            |sample: u16| (sample as f32 - 32_768.0) / 32_768.0,
            err_fn,
        ),
        SampleFormat::U32 => build_input_stream(
            &device,
            &stream_config,
            channels,
            sample_rate,
            packetizer,
            |sample: u32| (sample as f64 / u32::MAX as f64 * 2.0 - 1.0) as f32,
            err_fn,
        ),
        other => {
            return Err(format!(
                "Unsupported microphone sample format for native capture: {other:?}"
            ));
        }
    }
    .map_err(|err| format!("Failed to start microphone input stream: {err}"))?;

    stream
        .play()
        .map_err(|err| format!("Failed to play microphone input stream: {err}"))?;
    Ok(CaptureBackend::Microphone(MicrophoneCapture {
        _stream: stream,
    }))
}

fn build_input_stream<T, F, E>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    input_sample_rate: u32,
    packetizer: Arc<Mutex<Pcm16Packetizer>>,
    convert: F,
    err_fn: E,
) -> Result<Stream, cpal::Error>
where
    T: cpal::SizedSample,
    F: Fn(T) -> f32 + Send + Sync + 'static,
    E: FnMut(cpal::Error) + Send + 'static,
{
    device.build_input_stream(
        config.clone(),
        move |data: &[T], _| {
            let mono = interleaved_to_mono_f32(data, channels, &convert);
            let pcm16 = resample_f32_to_pcm16(&mono, input_sample_rate);
            if let Ok(mut packetizer) = packetizer.lock() {
                packetizer.push(&pcm16);
            }
        },
        err_fn,
        None,
    )
}

#[cfg(target_os = "macos")]
fn start_system_capture(
    app: &AppHandle,
    request: &NativeAudioStartRequest,
    packet_ms: u32,
) -> Result<CaptureBackend, String> {
    use screencapturekit::prelude::*;
    use screencapturekit::stream::configuration::{AudioChannelCount, AudioSampleRate};

    let content = SCShareableContent::get()
        .map_err(|err| format!("Failed to access ScreenCaptureKit content: {err}"))?;
    let display =
        content.displays().into_iter().next().ok_or_else(|| {
            "No display is available for ScreenCaptureKit audio capture.".to_string()
        })?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();
    let config = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_sample_rate(AudioSampleRate::Rate16000)
        .with_channel_count(AudioChannelCount::Mono)
        .with_excludes_current_process_audio(true);
    let packetizer = Arc::new(Mutex::new(Pcm16Packetizer::new(
        app.clone(),
        request.capture_id.clone(),
        NativeAudioSource::System,
        packet_ms,
    )));
    let status_app = app.clone();
    let status_capture_id = request.capture_id.clone();
    let handler_packetizer = packetizer.clone();
    let mut stream = SCStream::new(&filter, &config);

    let handler_id = stream.add_output_handler(
        move |sample: CMSampleBuffer, output_type: SCStreamOutputType| {
            if output_type != SCStreamOutputType::Audio {
                return;
            }
            if let Err(err) = process_system_sample_buffer(&sample, &handler_packetizer) {
                emit_status(
                    &status_app,
                    &status_capture_id,
                    NativeAudioSource::System,
                    "failed",
                    &err,
                );
            }
        },
        SCStreamOutputType::Audio,
    );
    if handler_id.is_none() {
        return Err(
            "ScreenCaptureKit rejected the system-audio output handler registration.".to_string(),
        );
    }

    stream
        .start_capture()
        .map_err(|err| format!("Failed to start ScreenCaptureKit system audio: {err}"))?;
    Ok(CaptureBackend::System(SystemCapture { stream }))
}

#[cfg(not(target_os = "macos"))]
fn start_system_capture(
    _app: &AppHandle,
    _request: &NativeAudioStartRequest,
    _packet_ms: u32,
) -> Result<CaptureBackend, String> {
    Err("Native system audio capture is currently available on macOS only.".to_string())
}

fn stop_capture_backend(backend: &mut CaptureBackend) -> Result<(), String> {
    match backend {
        CaptureBackend::Microphone(capture) => {
            let _ = &capture._stream;
            Ok(())
        }
        #[cfg(target_os = "macos")]
        CaptureBackend::System(capture) => capture
            .stream
            .stop_capture()
            .map_err(|err| format!("Failed to stop ScreenCaptureKit system audio: {err}")),
    }
}

#[cfg(target_os = "macos")]
fn process_system_sample_buffer(
    sample: &screencapturekit::prelude::CMSampleBuffer,
    packetizer: &Arc<Mutex<Pcm16Packetizer>>,
) -> Result<(), String> {
    use screencapturekit::prelude::CMSampleBufferExt;

    let _ = sample.make_data_ready();
    let format = sample
        .format_description()
        .ok_or_else(|| "System audio sample is missing a format description.".to_string())?;
    let input_sample_rate = format
        .audio_sample_rate()
        .unwrap_or(OUTPUT_SAMPLE_RATE as f64) as u32;
    let channels = format.audio_channel_count().unwrap_or(1) as usize;
    let bits_per_channel = format.audio_bits_per_channel().unwrap_or_else(|| {
        if format.audio_is_float() {
            32
        } else {
            16
        }
    });
    let buffers = sample
        .audio_buffer_list()
        .ok_or_else(|| "System audio sample is missing an audio buffer list.".to_string())?;
    let mono = audio_buffer_list_to_mono_f32(
        &buffers,
        channels.max(1),
        bits_per_channel,
        format.audio_is_float(),
        format.audio_is_big_endian(),
    )?;
    let pcm16 = resample_f32_to_pcm16(&mono, input_sample_rate);
    let mut guard = packetizer
        .lock()
        .map_err(|_| "System audio packetizer is unavailable.".to_string())?;
    guard.push(&pcm16);
    Ok(())
}

#[cfg(target_os = "macos")]
fn audio_buffer_list_to_mono_f32(
    buffers: &screencapturekit::cm::AudioBufferList,
    fallback_channels: usize,
    bits_per_channel: u32,
    is_float: bool,
    is_big_endian: bool,
) -> Result<Vec<f32>, String> {
    let mut decoded_buffers = Vec::new();
    for buffer in buffers.iter() {
        let channels = if buffer.number_channels > 0 {
            buffer.number_channels as usize
        } else {
            fallback_channels.max(1)
        };
        let decoded = decode_pcm_bytes_to_mono_f32(
            buffer.data(),
            channels,
            bits_per_channel,
            is_float,
            is_big_endian,
        )?;
        if !decoded.is_empty() {
            decoded_buffers.push(decoded);
        }
    }

    if decoded_buffers.is_empty() {
        return Ok(Vec::new());
    }
    if decoded_buffers.len() == 1 {
        return Ok(decoded_buffers.remove(0));
    }

    let frame_count = decoded_buffers
        .iter()
        .map(Vec::len)
        .min()
        .unwrap_or_default();
    let mut mono = vec![0.0; frame_count];
    for decoded in &decoded_buffers {
        for (index, sample) in decoded.iter().take(frame_count).enumerate() {
            mono[index] += *sample / decoded_buffers.len() as f32;
        }
    }
    Ok(mono)
}

fn decode_pcm_bytes_to_mono_f32(
    data: &[u8],
    channels: usize,
    bits_per_channel: u32,
    is_float: bool,
    is_big_endian: bool,
) -> Result<Vec<f32>, String> {
    let bytes_per_sample = (bits_per_channel / 8) as usize;
    if bytes_per_sample == 0 {
        return Ok(Vec::new());
    }
    let frame_bytes = bytes_per_sample * channels.max(1);
    if frame_bytes == 0 || data.len() < frame_bytes {
        return Ok(Vec::new());
    }
    let frame_count = data.len() / frame_bytes;
    let mut mono = Vec::with_capacity(frame_count);
    for frame in 0..frame_count {
        let mut sum = 0.0;
        for channel in 0..channels {
            let offset = frame * frame_bytes + channel * bytes_per_sample;
            sum += decode_pcm_sample(
                &data[offset..offset + bytes_per_sample],
                bits_per_channel,
                is_float,
                is_big_endian,
            )?;
        }
        mono.push(sum / channels as f32);
    }
    Ok(mono)
}

fn decode_pcm_sample(
    bytes: &[u8],
    bits_per_channel: u32,
    is_float: bool,
    is_big_endian: bool,
) -> Result<f32, String> {
    match (is_float, bits_per_channel) {
        (true, 32) => {
            let raw = [bytes[0], bytes[1], bytes[2], bytes[3]];
            Ok(if is_big_endian {
                f32::from_be_bytes(raw)
            } else {
                f32::from_le_bytes(raw)
            })
        }
        (true, 64) => {
            let raw = [
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ];
            Ok((if is_big_endian {
                f64::from_be_bytes(raw)
            } else {
                f64::from_le_bytes(raw)
            }) as f32)
        }
        (false, 16) => {
            let raw = [bytes[0], bytes[1]];
            let sample = if is_big_endian {
                i16::from_be_bytes(raw)
            } else {
                i16::from_le_bytes(raw)
            };
            Ok(sample as f32 / i16::MAX as f32)
        }
        (false, 32) => {
            let raw = [bytes[0], bytes[1], bytes[2], bytes[3]];
            let sample = if is_big_endian {
                i32::from_be_bytes(raw)
            } else {
                i32::from_le_bytes(raw)
            };
            Ok(sample as f32 / i32::MAX as f32)
        }
        _ => Err(format!(
            "Unsupported PCM sample format: float={is_float}, bits={bits_per_channel}"
        )),
    }
}

fn interleaved_to_mono_f32<T, F>(data: &[T], channels: usize, convert: &F) -> Vec<f32>
where
    T: Copy,
    F: Fn(T) -> f32,
{
    if data.is_empty() {
        return Vec::new();
    }
    let channels = channels.max(1);
    if channels == 1 {
        return data.iter().map(|sample| convert(*sample)).collect();
    }
    data.chunks_exact(channels)
        .map(|frame| frame.iter().map(|sample| convert(*sample)).sum::<f32>() / channels as f32)
        .collect()
}

fn resample_f32_to_pcm16(samples: &[f32], input_sample_rate: u32) -> Vec<i16> {
    if samples.is_empty() || input_sample_rate == 0 {
        return Vec::new();
    }
    let ratio = input_sample_rate as f64 / OUTPUT_SAMPLE_RATE as f64;
    let output_len = ((samples.len() as f64) / ratio).round().max(1.0) as usize;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let source_index = index as f64 * ratio;
        let low = source_index.floor() as usize;
        let high = (low + 1).min(samples.len() - 1);
        let weight = (source_index - low as f64) as f32;
        let sample = samples[low] * (1.0 - weight) + samples[high] * weight;
        output.push(float_to_pcm16(sample));
    }
    output
}

fn float_to_pcm16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    if clamped < 0.0 {
        (clamped * 32_768.0).round() as i16
    } else {
        (clamped * 32_767.0).round() as i16
    }
}

fn clamp_packet_ms(value: u32) -> u32 {
    value.clamp(100, 200)
}

fn duration_ms_for_samples(sample_count: usize) -> u32 {
    ((sample_count as f64 / OUTPUT_SAMPLE_RATE as f64) * 1000.0)
        .round()
        .max(1.0) as u32
}

fn emit_status(
    app: &AppHandle,
    capture_id: &str,
    source: NativeAudioSource,
    status: &str,
    message: &str,
) {
    let event = NativeAudioStatusEvent {
        capture_id: capture_id.to_string(),
        source: source.as_str().to_string(),
        status: status.to_string(),
        message: message.to_string(),
        created_at: now_ms(),
    };
    let _ = app.emit(AUDIO_STATUS_EVENT, event);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_system_audio_label() {
        assert!(validate_system_audio_label("   ").is_err());
    }

    #[test]
    fn accepts_named_system_audio_label() {
        assert_eq!(
            validate_system_audio_label("System Audio").unwrap(),
            "System Audio"
        );
    }

    #[test]
    fn decodes_little_endian_float32_pcm_to_mono() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0.25_f32.to_le_bytes());
        bytes.extend_from_slice(&0.75_f32.to_le_bytes());
        bytes.extend_from_slice(&(-0.25_f32).to_le_bytes());
        bytes.extend_from_slice(&(-0.75_f32).to_le_bytes());

        let mono = decode_pcm_bytes_to_mono_f32(&bytes, 2, 32, true, false).unwrap();

        assert_eq!(mono, vec![0.5, -0.5]);
    }

    #[test]
    fn resamples_and_clamps_to_pcm16() {
        let pcm16 = resample_f32_to_pcm16(&[-1.0, 0.0, 1.0], 48_000);

        assert_eq!(pcm16, vec![-32_768]);
    }

    #[test]
    fn clamps_packet_size_to_streaming_bounds() {
        assert_eq!(clamp_packet_ms(20), 100);
        assert_eq!(clamp_packet_ms(150), 150);
        assert_eq!(clamp_packet_ms(500), 200);
    }
}
