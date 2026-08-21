use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use windows::core::GUID;
use windows::Win32::Media::Audio::{
    IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, EDataFlow, ERole, eConsole, eRender,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

const WAVE_TAG_FLOAT: u16 = 0x0003; // WAVE_FORMAT_IEEE_FLOAT
const WAVE_TAG_EXTENSIBLE: u16 = 0xFFFE; // WAVE_FORMAT_EXTENSIBLE

/// KSDATAFORMAT_SUBTYPE_PCM = {00000001-0000-0010-8000-00AA00389B71}
const SUBTYPE_PCM: GUID = GUID::from_u128(0x0000_0001_0000_0010_8000_00AA_0038_9B71);
/// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = {00000003-0000-0010-8000-00AA00389B73}
const SUBTYPE_FLOAT: GUID = GUID::from_u128(0x0000_0003_0000_0010_8000_00AA_0038_9B73);
/// CLSID_MMDeviceEnumerator = {BCDE0395-E52F-467C-8E3D-C4579291692E}
const CLSID_MM_DEVICE_ENUMERATOR: GUID = GUID::from_u128(0xBCDE_0395_E52F_467C_8E3D_C457_9291_692E);

const CHUNK: usize = 1024;

/// 调试日志：仅 debug 构建输出，避免生产刷屏
macro_rules! adbg {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) { eprintln!($($arg)*); }
    };
}

/// 后台线程：以回环模式捕获系统默认输出设备，切块后通过
/// `audio:pcm` 事件推给前端（Vec<f32> 单声道波形）。
/// 设备拔插/驱动重置等瞬时错误不应让功能永久失效：
/// 出错后退避重试（仅首次上报一次错误事件，避免风暴），设备恢复后自动续传。
pub fn start_loopback_capture(app: AppHandle, enabled: Arc<AtomicBool>) {
    adbg!("[audio] WASAPI 回环捕获线程启动");
    let mut error_reported = false;
    loop {
        match run_capture(app.clone(), enabled.clone()) {
            Ok(()) => {
                adbg!("[audio] 捕获线程正常退出");
                return;
            }
            Err(e) => {
                adbg!("[audio] 捕获失败: {e}");
                if !error_reported {
                    error_reported = true;
                    let _ = app.emit("audio:error", format!("音频捕获不可用：{e}"));
                }
                std::thread::sleep(std::time::Duration::from_secs(3));
            }
        }
    }
}

fn run_capture(app: AppHandle, enabled: Arc<AtomicBool>) -> Result<(), String> {
    adbg!("[audio] 初始化 COM...");
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
    }
    adbg!("[audio] COM 初始化完成，进入捕获循环...");
    let result = unsafe { capture_loop(&app, &enabled) };
    unsafe { CoUninitialize() };
    adbg!("[audio] 捕获循环结束: {:?}", result.is_ok());
    result
}

unsafe fn capture_loop(app: &AppHandle, enabled: &AtomicBool) -> Result<(), String> {
    adbg!("[audio] 创建设备枚举器...");
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&CLSID_MM_DEVICE_ENUMERATOR, None, CLSCTX_ALL)
            .map_err(|e| format!("无法创建设备枚举器：{e}"))?;
    adbg!("[audio] 设备枚举器创建成功");

    adbg!("[audio] 获取默认输出设备...");
    let device = enumerator
        .GetDefaultAudioEndpoint(EDataFlow(eRender.0), ERole(eConsole.0))
        .map_err(|e| format!("无法获取默认输出设备：{e}"))?;
    adbg!("[audio] 默认输出设备获取成功");

    adbg!("[audio] 激活音频客户端...");
    let client: IAudioClient = device
        .Activate::<IAudioClient>(CLSCTX_ALL, None)
        .map_err(|e| format!("激活音频客户端失败：{e}"))?;
    adbg!("[audio] 音频客户端激活成功");

    let format_ptr = client.GetMixFormat().map_err(|e| e.to_string())?;
    if format_ptr.is_null() {
        return Err("GetMixFormat 返回空".into());
    }
    let fmt = &*format_ptr;
    let channels = fmt.nChannels as usize;
    let bits = fmt.wBitsPerSample as usize;
    let is_float = is_float_format(fmt.wFormatTag, format_ptr);
    let tag = fmt.wFormatTag;
    adbg!("[audio] 格式: {channels}ch, {bits}bit, float={is_float}, tag=0x{tag:04X}");

    adbg!("[audio] 初始化回环捕获...");
    client
        .Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            0,
            0,
            format_ptr,
            None,
        )
        .map_err(|e| format!("回环捕获初始化失败 (0x{:08X})：{e}", e.code().0))?;
    adbg!("[audio] 回环捕获初始化成功");

    let capture: IAudioCaptureClient = client
        .GetService::<IAudioCaptureClient>()
        .map_err(|e| format!("获取捕获端点失败：{e}"))?;

    client.Start().map_err(|e| e.to_string())?;
    adbg!("[audio] 捕获已开始，进入数据循环...");

    let mut mono: Vec<f32> = Vec::with_capacity(CHUNK);
    let mut emit_count: u32 = 0;
    loop {
        if !enabled.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }
        let packet_count = capture.GetNextPacketSize().map_err(|e| e.to_string())?;
        if packet_count == 0 {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }
        for _ in 0..packet_count {
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames: u32 = 0;
            let mut flags: u32 = 0;
            capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                .map_err(|e| e.to_string())?;
            if frames > 0 {
                // 无论数据是否可读都必须 ReleaseBuffer，否则泄漏 WASAPI 包
                if !data.is_null() {
                    if is_float && bits == 32 {
                        let vals =
                            std::slice::from_raw_parts(data as *const f32, frames as usize * channels);
                        for f in vals.chunks_exact(channels) {
                            // 多声道取平均（保留正负波形），不用 RMS（RMS 丢失正负信息导致 FFT 失效）
                            mono.push(f.iter().sum::<f32>() / channels as f32);
                        }
                    } else {
                        let bps = bits / 8;
                        // bps==0（异常位深）跳过处理，避免 chunks_exact(0) panic
                        if bps > 0 {
                            let bytes = std::slice::from_raw_parts(
                                data,
                                frames as usize * channels * bps,
                            );
                            for frm in bytes.chunks_exact(channels * bps) {
                                // 多声道取平均（保留正负波形）
                                let avg: f64 = frm
                                    .chunks_exact(bps)
                                    .map(|ch| decode_int_sample(ch, bps))
                                    .sum::<f64>()
                                    / channels as f64;
                                mono.push(avg as f32);
                            }
                        }
                    }
                }
                capture.ReleaseBuffer(frames).map_err(|e| e.to_string())?;
            }
        }
        while mono.len() >= CHUNK {
            let chunk: Vec<f32> = mono.drain(..CHUNK).collect();
            emit_count += 1;
            if emit_count <= 3 || emit_count % 500 == 0 {
                adbg!(
                    "[audio] emit audio:pcm #{emit_count}, {}采样, rms={:.4}",
                    chunk.len(),
                    (chunk.iter().map(|v| v * v).sum::<f32>() / chunk.len() as f32).sqrt()
                );
            }
            let _ = app.emit("audio:pcm", chunk);
        }
    }
}

/// 通道 RMS（仅用于日志/诊断，不用于 PCM 数据流）
#[allow(dead_code)]
fn rms(f: &[f32]) -> f32 {
    let n = f.len() as f32;
    (f.iter().map(|v| v * v).sum::<f32>() / n).sqrt()
}

/// WAVEFORMATEXTENSIBLE 是 packed（1 字节对齐），字段必须用 read_unaligned 读取，
/// 不能直接解引用（会触发 E0793 unaligned 错误）。
fn is_float_format(tag: u16, format_ptr: *mut WAVEFORMATEX) -> bool {
    if tag == WAVE_TAG_FLOAT {
        return true;
    }
    if tag == WAVE_TAG_EXTENSIBLE {
        let ext = format_ptr as *const WAVEFORMATEXTENSIBLE;
        unsafe { std::ptr::addr_of!((*ext).SubFormat).read_unaligned() == SUBTYPE_FLOAT }
    } else {
        false
    }
}

fn decode_int_sample(bytes: &[u8], bps: usize) -> f64 {
    match bps {
        1 => (i32::from(bytes[0]) - 128) as f64 / 128.0,
        2 => i16::from_le_bytes([bytes[0], bytes[1]]) as f64 / 32768.0,
        3 => {
            let mut v = i32::from(bytes[0]) | (i32::from(bytes[1]) << 8);
            v |= (bytes[2] as i8 as i32) << 16;
            v as f64 / 8388608.0
        }
        4 => i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f64 / 2147483648.0,
        _ => 0.0,
    }
}

#[allow(dead_code)]
const _SUBTYPE_PCM_GUARD: GUID = SUBTYPE_PCM;
