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

pub fn spawn_mixer(listener: TcpListener, stop: Arc<AtomicBool>, system_sound: bool, mic: bool) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let mut sources: Vec<(Queue, cpal::Stream)> = Vec::new();
        if system_sound {
            // On Windows (WASAPI) an input stream on the output device is a loopback capture.
            if let Some(dev) = host.default_output_device() {
                if let Ok(cfg) = dev.default_output_config() {
                    let q: Queue = Default::default();
                    if let Some(s) = open(dev, cfg, q.clone()) {
                        sources.push((q, s));
                    }
                }
            }
        }
        if mic {
            if let Some(dev) = host.default_input_device() {
                if let Ok(cfg) = dev.default_input_config() {
                    let q: Queue = Default::default();
                    if let Some(s) = open(dev, cfg, q.clone()) {
                        sources.push((q, s));
                    }
                }
            }
        }

        // ffmpeg connects once it opens its inputs
        let _ = listener.set_nonblocking(true);
        let wait = Instant::now();
        let mut pipe = loop {
            match listener.accept() {
                Ok((sock, _)) => break sock,
                Err(_) if wait.elapsed() < Duration::from_secs(15) && !stop.load(Ordering::SeqCst) => std::thread::sleep(Duration::from_millis(10)),
                Err(_) => return,
            }
        };
        let _ = pipe.set_nonblocking(false);
        let _ = pipe.set_nodelay(true);

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
            for (q, _) in &sources {
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
