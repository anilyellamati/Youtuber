//! Audio mixer: computer sound (WASAPI loopback) + microphone, mixed to 48 kHz
//! stereo float and sent to ffmpeg over a loopback socket on a steady wall-clock schedule.
//! Silence is written when a source has nothing, which keeps audio and video in
//! sync (loopback delivers no packets while the PC is silent).

use std::collections::VecDeque;
use std::io::Write;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

const RATE: u32 = 48_000;
type Queue = Arc<Mutex<VecDeque<f32>>>; // interleaved stereo @ 48 kHz

/// Converts a device buffer (any rate / channel count) to 48 kHz stereo.
struct Converter {
    channels: usize,
    step: f64, // input frames per output frame
    pos: f64,
    queue: Queue,
}

impl Converter {
    fn push(&mut self, data: &[f32]) {
        let frames = data.len() / self.channels;
        if frames == 0 {
            return;
        }
        let mut q = self.queue.lock().unwrap();
        while (self.pos as usize) < frames {
            let i = self.pos as usize * self.channels;
            let l = data[i];
            let r = if self.channels > 1 { data[i + 1] } else { l };
            q.push_back(l);
            q.push_back(r);
            self.pos += self.step;
        }
        self.pos -= frames as f64;
        // never let a stalled writer grow memory: keep at most 2 s
        let max = RATE as usize * 2 * 2;
        while q.len() > max {
            q.pop_front();
        }
    }
}

fn open(device: cpal::Device, config: cpal::SupportedStreamConfig, queue: Queue) -> Option<cpal::Stream> {
    let mut conv = Converter { channels: config.channels() as usize, step: config.sample_rate().0 as f64 / RATE as f64, pos: 0.0, queue };
    let cfg: cpal::StreamConfig = config.config();
    let err = |_e| {};
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(&cfg, move |d: &[f32], _: &_| conv.push(d), err, None),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &cfg,
            move |d: &[i16], _: &_| {
                let f: Vec<f32> = d.iter().map(|v| *v as f32 / 32768.0).collect();
                conv.push(&f)
            },
            err,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &cfg,
            move |d: &[u16], _: &_| {
                let f: Vec<f32> = d.iter().map(|v| (*v as f32 - 32768.0) / 32768.0).collect();
                conv.push(&f)
            },
            err,
            None,
        ),
        _ => return None,
    }
    .ok()?;
    stream.play().ok()?;
    Some(stream)
}

/// The channel that carries mixed audio to ffmpeg. On Windows this is a named pipe:
/// no networking is involved, so firewalls and antivirus cannot block or delay it.
/// Elsewhere (development) it is a loopback socket.
pub enum Sink {
    #[cfg_attr(windows, allow(dead_code))]
    Tcp(TcpListener),
    #[cfg(windows)]
    Pipe(std::fs::File),
}

impl Sink {
    /// Creates the channel and returns it with the input URL to give ffmpeg.
    /// Must be called before ffmpeg starts so the endpoint already exists.
    pub fn create() -> Result<(Sink, String), String> {
        #[cfg(windows)]
        {
            use winapi::um::handleapi::INVALID_HANDLE_VALUE;
            use winapi::um::namedpipeapi::CreateNamedPipeW;
            use winapi::um::winbase::{PIPE_ACCESS_OUTBOUND, PIPE_TYPE_BYTE, PIPE_WAIT};
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
            let path = format!(r"\\.\pipe\sfrec-audio-{}-{}", std::process::id(), nanos);
            let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
            let h = unsafe { CreateNamedPipeW(wide.as_ptr(), PIPE_ACCESS_OUTBOUND, PIPE_TYPE_BYTE | PIPE_WAIT, 1, 1 << 20, 0, 0, std::ptr::null_mut()) };
            if h == INVALID_HANDLE_VALUE {
                return Err("Could not create the audio pipe".into());
            }
            // Owned as a File from the start: whatever happens to the mixer, the pipe is
            // closed when it is dropped, so ffmpeg can never be left waiting on it.
            use std::os::windows::io::FromRawHandle;
            return Ok((Sink::Pipe(unsafe { std::fs::File::from_raw_handle(h as _) }), path));
        }
        #[cfg(not(windows))]
        {
            let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
            let port = l.local_addr().map_err(|e| e.to_string())?.port();
            Ok((Sink::Tcp(l), format!("tcp://127.0.0.1:{port}")))
        }
    }

    /// Waits for ffmpeg to open the channel.
    fn connect(self, stop: &AtomicBool) -> Option<Box<dyn Write>> {
        match self {
            Sink::Tcp(listener) => {
                let _ = listener.set_nonblocking(true);
                let wait = Instant::now();
                loop {
                    match listener.accept() {
                        Ok((sock, _)) => {
                            let _ = sock.set_nonblocking(false);
                            let _ = sock.set_nodelay(true);
                            return Some(Box::new(sock));
                        }
                        Err(_) if wait.elapsed() < Duration::from_secs(60) && !stop.load(Ordering::SeqCst) => std::thread::sleep(Duration::from_millis(10)),
                        Err(_) => return None,
                    }
                }
            }
            #[cfg(windows)]
            Sink::Pipe(file) => {
                use std::os::windows::io::AsRawHandle;
                use winapi::um::errhandlingapi::GetLastError;
                use winapi::um::namedpipeapi::ConnectNamedPipe;
                const ERROR_PIPE_CONNECTED: u32 = 535;
                let h = file.as_raw_handle() as winapi::um::winnt::HANDLE;
                // Blocks until ffmpeg opens the pipe. Recording::stop opens it itself to
                // release this wait if ffmpeg never got that far.
                let ok = unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) != 0 || GetLastError() == ERROR_PIPE_CONNECTED };
                (ok && !stop.load(Ordering::SeqCst)).then(|| Box::new(file) as Box<dyn Write>)
            }
        }
    }
}

/// Opens the sound devices on a thread of its own and keeps them running until
/// `stop`. Some audio drivers take very long (or forever) to open; that must never
/// hold up the recording, so the mixer does not wait for this thread.
fn spawn_devices(queues: Arc<Mutex<Vec<Queue>>>, stop: Arc<AtomicBool>, system_sound: bool, mic: Option<String>) {
    std::thread::spawn(move || {
        if std::env::var_os("SFREC_TEST_AUDIO_HANG").is_some() {
            // test hook: behave like a driver that never answers
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(100));
            }
            return;
        }
        let host = cpal::default_host();
        let mut streams: Vec<cpal::Stream> = Vec::new();
        let mut add = |dev: cpal::Device, cfg: cpal::SupportedStreamConfig| {
            let q: Queue = Default::default();
            if let Some(s) = open(dev, cfg, q.clone()) {
                queues.lock().unwrap().push(q);
                streams.push(s);
            }
        };
        if system_sound {
            // On Windows (WASAPI) an input stream on the output device is a loopback capture.
            if let Some(dev) = host.default_output_device() {
                if let Ok(cfg) = dev.default_output_config() {
                    add(dev, cfg);
                }
            }
        }
        if let Some(name) = mic {
            let chosen = if name.is_empty() {
                None
            } else {
                host.input_devices().ok().and_then(|mut d| d.find(|x| x.name().map(|n| n == name).unwrap_or(false)))
            };
            if let Some(dev) = chosen.or_else(|| host.default_input_device()) {
                if let Ok(cfg) = dev.default_input_config() {
                    add(dev, cfg);
                }
            }
        }
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(streams);
    });
}

pub fn spawn_mixer(sink: Sink, stop: Arc<AtomicBool>, system_sound: bool, mic: Option<String>) -> std::thread::JoinHandle<()> {
    let queues: Arc<Mutex<Vec<Queue>>> = Default::default();
    spawn_devices(queues.clone(), stop.clone(), system_sound, mic);
    std::thread::spawn(move || {
        // ffmpeg connects once it opens its inputs; it gets sound (or silence) at once
        let Some(mut pipe) = sink.connect(&stop) else { return };
        for q in queues.lock().unwrap().iter() {
            q.lock().unwrap().clear(); // drop sound captured before the recording began
        }

        let start = Instant::now();
        let mut written: u64 = 0; // frames
        let mut bytes: Vec<u8> = Vec::with_capacity(RATE as usize / 10 * 8);
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(20));
            let due = (start.elapsed().as_secs_f64() * RATE as f64) as u64;
            let n = due.saturating_sub(written).min(RATE as u64) as usize; // frames to write now
            if n == 0 {
                continue;
            }
            let mut mix = vec![0f32; n * 2];
            for q in queues.lock().unwrap().iter() {
                let mut q = q.lock().unwrap();
                for m in mix.iter_mut() {
                    match q.pop_front() {
                        Some(v) => *m += v,
                        None => break,
                    }
                }
            }
            bytes.clear();
            for v in &mix {
                bytes.extend_from_slice(&v.clamp(-1.0, 1.0).to_le_bytes());
            }
            if pipe.write_all(&bytes).is_err() {
                break; // ffmpeg exited
            }
            written += n as u64;
        }
        drop(pipe); // EOF on audio: ffmpeg finishes the file
    })
}

/// Names of the connected microphones / audio inputs.
pub fn list_mics() -> Vec<String> {
    cpal::default_host()
        .input_devices()
        .map(|d| d.filter_map(|x| x.name().ok()).collect())
        .unwrap_or_default()
}
