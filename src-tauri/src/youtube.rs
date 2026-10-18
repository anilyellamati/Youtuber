//! YouTube sign-in (OAuth 2.0 for installed apps: loopback redirect + PKCE) and
//! resumable uploads, streamed from disk in chunks so multi-GB recordings never sit
//! in memory and can survive a dropped connection.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPES: &str = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
const CHUNK: u64 = 8 * 1024 * 1024; // must be a multiple of 256 KiB

/// Set at build time (`SF_GOOGLE_CLIENT_ID`, `SF_GOOGLE_CLIENT_SECRET`) so users get
/// one-click sign-in; can be overridden from Settings.
const BUILT_IN_CLIENT_ID: Option<&str> = option_env!("SF_GOOGLE_CLIENT_ID");
const BUILT_IN_CLIENT_SECRET: Option<&str> = option_env!("SF_GOOGLE_CLIENT_SECRET");

#[derive(Serialize, Deserialize, Clone)]
struct Tokens {
    client_id: String,
    client_secret: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}

#[derive(Serialize)]
pub struct Channel {
    id: String,
    title: String,
    thumbnail: String,
    subscribers: String,
    videos: String,
}

#[derive(Serialize, Clone)]
struct UploadProgress {
    id: String,
    sent: u64,
    total: u64,
    stage: String,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn token_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("youtube_auth.json"))
}

fn save_tokens(app: &AppHandle, t: &Tokens) -> Result<(), String> {
    let path = token_file(app)?;
    std::fs::write(&path, serde_json::to_vec(t).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn load_tokens(app: &AppHandle) -> Option<Tokens> {
    let bytes = std::fs::read(token_file(app).ok()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("StreamForge/1.0")
        .connect_timeout(Duration::from_secs(20))
        .build()
        .expect("http client")
}

async fn api_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    let msg = body["error"]["message"]
        .as_str()
        .or_else(|| body["error_description"].as_str())
        .unwrap_or("request failed");
    format!("YouTube API {status}: {msg}")
}

async fn fresh_access_token(app: &AppHandle) -> Result<String, String> {
    let mut t = load_tokens(app).ok_or("Not signed in to YouTube")?;
    if t.expires_at > now() + 60 {
        return Ok(t.access_token);
    }
    let resp = http()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", t.client_id.as_str()),
            ("client_secret", t.client_secret.as_str()),
            ("refresh_token", t.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Session expired, please sign in again. ({})", api_error(resp).await));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    t.access_token = body["access_token"].as_str().unwrap_or_default().to_string();
    t.expires_at = now() + body["expires_in"].as_u64().unwrap_or(3600);
    save_tokens(app, &t)?;
    Ok(t.access_token)
}

async fn fetch_channel(token: &str) -> Result<Channel, String> {
    let resp = http()
        .get("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let item = &body["items"][0];
    if item.is_null() {
        return Err("This Google account has no YouTube channel yet. Create one at youtube.com first.".into());
    }
    Ok(Channel {
        id: item["id"].as_str().unwrap_or_default().into(),
        title: item["snippet"]["title"].as_str().unwrap_or_default().into(),
        thumbnail: item["snippet"]["thumbnails"]["default"]["url"].as_str().unwrap_or_default().into(),
        subscribers: item["statistics"]["subscriberCount"].as_str().unwrap_or("0").into(),
        videos: item["statistics"]["videoCount"].as_str().unwrap_or("0").into(),
    })
}

fn random_b64(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Blocks (on a worker thread) until Google redirects the browser back to the
/// loopback listener, then returns the authorization code.
fn wait_for_code(listener: TcpListener, state: String) -> Result<String, String> {
    listener.set_nonblocking(false).map_err(|e| e.to_string())?;
    let deadline = SystemTime::now() + Duration::from_secs(300);
    loop {
        if SystemTime::now() > deadline {
            return Err("Sign-in timed out".into());
        }
        let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).map_err(|e| e.to_string())?;
        let target = line.split_whitespace().nth(1).unwrap_or("/");
        let parsed = url::Url::parse(&format!("http://localhost{target}")).map_err(|e| e.to_string())?;
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        if params.is_empty() {
            let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\n\r\n");
            continue; // favicon or similar
        }
        let ok = params.get("state") == Some(&state) && params.contains_key("code");
        let page = if ok {
            "<h2 style='font-family:sans-serif'>You're signed in to StreamForge. You can close this tab.</h2>"
        } else {
            "<h2 style='font-family:sans-serif'>Sign-in was cancelled or failed. Return to StreamForge.</h2>"
        };
        let _ = stream.write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len())
                .as_bytes(),
        );
        if ok {
            return Ok(params["code"].clone());
        }
        return Err(params.get("error").cloned().unwrap_or_else(|| "Sign-in failed".into()));
    }
}

#[tauri::command]
pub async fn yt_login(
    app: AppHandle,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<Channel, String> {
    let client_id = client_id
        .filter(|s| !s.trim().is_empty())
        .or(BUILT_IN_CLIENT_ID.map(String::from))
        .ok_or("Add your Google OAuth Client ID in Settings → YouTube to enable sign-in.")?;
    let client_secret = client_secret
        .filter(|s| !s.trim().is_empty())
        .or(BUILT_IN_CLIENT_SECRET.map(String::from))
        .unwrap_or_default();

    let verifier = random_b64(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16);
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());

    let mut auth = url::Url::parse(AUTH_URL).unwrap();
    auth.query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent select_account");
    app.opener().open_url(auth.as_str(), None::<&str>).map_err(|e| e.to_string())?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, state))
        .await
        .map_err(|e| e.to_string())??;

    let resp = http()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let tokens = Tokens {
        client_id,
        client_secret,
        access_token: body["access_token"].as_str().unwrap_or_default().into(),
        refresh_token: body["refresh_token"].as_str().unwrap_or_default().into(),
        expires_at: now() + body["expires_in"].as_u64().unwrap_or(3600),
    };
    save_tokens(&app, &tokens)?;
    fetch_channel(&tokens.access_token).await
}

#[tauri::command]
pub async fn yt_status(app: AppHandle) -> Result<Option<Channel>, String> {
    if load_tokens(&app).is_none() {
        return Ok(None);
    }
    let token = fresh_access_token(&app).await?;
    fetch_channel(&token).await.map(Some)
}

#[tauri::command]
pub async fn yt_logout(app: AppHandle) -> Result<(), String> {
    if let Some(t) = load_tokens(&app) {
        let _ = http()
            .post("https://oauth2.googleapis.com/revoke")
            .form(&[("token", t.refresh_token.as_str())])
            .send()
            .await;
    }
    let _ = std::fs::remove_file(token_file(&app)?);
    Ok(())
}

/// Uploads `path` with `metadata` (a YouTube `videos` resource: snippet + status),
/// then sets the custom thumbnail if given. Returns the new video id.
#[tauri::command]
pub async fn yt_upload(
    app: AppHandle,
    id: String,
    path: String,
    metadata: Value,
    thumbnail: Option<String>,
    notify: Option<bool>,
) -> Result<String, String> {
    let emit = |sent: u64, total: u64, stage: &str| {
        let _ = app.emit("youtube://progress", UploadProgress { id: id.clone(), sent, total, stage: stage.into() });
    };
    let total = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?.len();
    let token = fresh_access_token(&app).await?;
    emit(0, total, "starting");

    let init = http()
        .post(format!(
            "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers={}",
            notify.unwrap_or(true)
        ))
        .bearer_auth(&token)
        .header("X-Upload-Content-Length", total.to_string())
        .header("X-Upload-Content-Type", "video/*")
        .json(&metadata)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !init.status().is_success() {
        return Err(api_error(init).await);
    }
    let session = init
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .ok_or("YouTube did not return an upload session")?
        .to_string();

    let mut file = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
    let mut offset: u64 = 0;
    let mut retries = 0;
    let video: Value = loop {
        let len = CHUNK.min(total - offset);
        let mut buf = vec![0u8; len as usize];
        file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
        file.read_exact(&mut buf).await.map_err(|e| e.to_string())?;
        let token = fresh_access_token(&app).await?;
        let range = if total == 0 { "bytes */0".to_string() } else { format!("bytes {}-{}/{}", offset, offset + len - 1, total) };
        let sent = http()
            .put(&session)
            .bearer_auth(&token)
            .header("Content-Range", range)
            .body(buf)
            .timeout(Duration::from_secs(600))
            .send()
            .await;
        match sent {
            Ok(resp) if resp.status().as_u16() == 308 => {
                // Resume Incomplete: the Range header says what YouTube has.
                offset = resp
                    .headers()
                    .get("range")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|r| r.rsplit('-').next())
                    .and_then(|n| n.parse::<u64>().ok())
                    .map(|n| n + 1)
                    .unwrap_or(0);
                retries = 0;
                emit(offset, total, "uploading");
            }
            Ok(resp) if resp.status().is_success() => break resp.json().await.map_err(|e| e.to_string())?,
            Ok(resp) if resp.status().is_server_error() && retries < 6 => {
                retries += 1;
                tokio::time::sleep(Duration::from_secs(2u64.pow(retries))).await;
                offset = query_offset(&session, &token, total).await.unwrap_or(offset);
            }
            Ok(resp) => return Err(api_error(resp).await),
            Err(_) if retries < 6 => {
                retries += 1;
                emit(offset, total, "reconnecting");
                tokio::time::sleep(Duration::from_secs(2u64.pow(retries))).await;
                offset = query_offset(&session, &token, total).await.unwrap_or(offset);
            }
            Err(e) => return Err(format!("Upload failed: {e}")),
        }
    };
    let video_id = video["id"].as_str().unwrap_or_default().to_string();
    emit(total, total, "processing");

    if let Some(thumb) = thumbnail.filter(|t| !t.is_empty()) {
        emit(total, total, "thumbnail");
        let bytes = tokio::fs::read(&thumb).await.map_err(|e| e.to_string())?;
        let mime = if thumb.to_lowercase().ends_with(".png") { "image/png" } else { "image/jpeg" };
        let resp = http()
            .post(format!("https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId={video_id}"))
            .bearer_auth(fresh_access_token(&app).await?)
            .header("Content-Type", mime)
            .body(bytes)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            // Custom thumbnails need a verified channel; the video itself is fine.
            let msg = api_error(resp).await;
            emit(total, total, &format!("thumbnail skipped: {msg}"));
        }
    }
    emit(total, total, "done");
    Ok(video_id)
}

async fn query_offset(session: &str, token: &str, total: u64) -> Option<u64> {
    let resp = http()
        .put(session)
        .bearer_auth(token)
        .header("Content-Range", format!("bytes */{total}"))
        .send()
        .await
        .ok()?;
    if resp.status().as_u16() != 308 {
        return None;
    }
    Some(
        resp.headers()
            .get("range")
            .and_then(|v| v.to_str().ok())
            .and_then(|r| r.rsplit('-').next())
            .and_then(|n| n.parse::<u64>().ok())
            .map(|n| n + 1)
            .unwrap_or(0),
    )
}
