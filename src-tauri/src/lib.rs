// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::path::PathBuf;
use tauri::{Emitter, Runtime};
use tauri_plugin_shell::ShellExt;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoFormat {
    pub format_id: String,
    pub ext: String,
    pub resolution: Option<String>,
    pub fps: Option<u32>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub filesize: Option<u64>,
    pub format_note: Option<String>,
    pub quality_label: String,
    pub quality_key: String,
    pub height: Option<u32>,
    pub has_video: bool,
    pub has_audio: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VideoInfo {
    pub id: String,
    pub title: String,
    pub thumbnail: Option<String>,
    pub duration: Option<u64>,
    pub uploader: Option<String>,
    pub formats: Vec<VideoFormat>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadProgress {
    pub status: String,
    pub percent: Option<f64>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DownloadOptions {
    pub url: String,
    pub quality: String,
    pub output_dir: String,
    pub filename_template: Option<String>,
}

#[tauri::command]
async fn get_video_info<R: Runtime>(app: tauri::AppHandle<R>, url: String) -> Result<VideoInfo, String> {
    let shell = app.shell();
    let sidecar = shell.sidecar("yt-dlp").map_err(|e| format!("Failed to create sidecar: {}", e))?;

    eprintln!("[AeroFetch] Getting info for: {}", url);

    let output = sidecar
        .args([
            "--dump-json",
            "--no-download",
            "--no-warnings",
            "--no-playlist",
            &url,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[AeroFetch] yt-dlp info error: {}", stderr);
        return Err(format!("yt-dlp error: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json_str = stdout.lines().next().ok_or("No output from yt-dlp")?;

    let json_value: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

    let formats = parse_formats(&json_value);

    if formats.is_empty() {
        return Err("No downloadable video formats found for this URL".to_string());
    }

    Ok(VideoInfo {
        id: json_value["id"].as_str().unwrap_or("").to_string(),
        title: json_value["title"].as_str().unwrap_or("Unknown").to_string(),
        thumbnail: json_value["thumbnail"].as_str().map(|s| s.to_string()),
        duration: json_value["duration"].as_u64(),
        uploader: json_value["uploader"].as_str().map(|s| s.to_string()),
        formats,
    })
}

fn parse_formats(json: &serde_json::Value) -> Vec<VideoFormat> {
    let mut formats = Vec::new();

    if let Some(formats_array) = json["formats"].as_array() {
        for f in formats_array {
            let vcodec = f["vcodec"].as_str().unwrap_or("none");
            let acodec = f["acodec"].as_str().unwrap_or("none");

            let has_video = vcodec != "none" && !vcodec.is_empty();
            let has_audio = acodec != "none" && !acodec.is_empty();

            let resolution = f["resolution"].as_str().map(|s| s.to_string());
            let format_note = f["format_note"].as_str().map(|s| s.to_string());
            let height = f["height"].as_u64().map(|h| h as u32);

            let quality_label = match (resolution.clone(), format_note.clone(), height) {
                (Some(res), Some(note), _) if !res.is_empty() && !note.is_empty() => format!("{} ({})", res, note),
                (Some(res), _, _) if !res.is_empty() => res,
                (_, Some(note), _) if !note.is_empty() => note,
                (_, _, Some(h)) if h > 0 => format!("{}p", h),
                _ => f["format_id"].as_str().unwrap_or("unknown").to_string(),
            };

            formats.push(VideoFormat {
                format_id: f["format_id"].as_str().unwrap_or("").to_string(),
                ext: f["ext"].as_str().unwrap_or("mp4").to_string(),
                resolution,
                fps: f["fps"].as_u64().map(|v| v as u32),
                vcodec: if has_video { Some(vcodec.to_string()) } else { None },
                acodec: if has_audio { Some(acodec.to_string()) } else { None },
                filesize: f["filesize"].as_u64().or_else(|| f["filesize_approx"].as_u64()),
                format_note,
                quality_label,
                quality_key: height
                    .map(|h| format!("{}p", h))
                    .unwrap_or_else(|| "best".to_string()),
                height,
                has_video,
                has_audio,
            });
        }
    }

    // Keep only formats that have video
    formats.retain(|f| f.has_video);
    formats.sort_by(|a, b| {
        let a_height = a.height.unwrap_or(0);
        let b_height = b.height.unwrap_or(0);
        b_height.cmp(&a_height)
    });

    // Deduplicate by height, keep the best quality for each height
    let mut seen_heights = std::collections::HashSet::new();
    formats.retain(|f| {
        if let Some(h) = f.height {
            seen_heights.insert(h)
        } else {
            true
        }
    });

    // Add a "best" option at the top
    if !formats.is_empty() {
        let mut best = formats[0].clone();
        best.format_id = "best".to_string();
        best.quality_label = format!("Best ({})", formats[0].quality_label);
        best.quality_key = "best".to_string();
        formats.insert(0, best);
    }

    formats
}

#[tauri::command]
async fn download_video<R: Runtime>(
    app: tauri::AppHandle<R>,
    options: DownloadOptions,
) -> Result<String, String> {
    let shell = app.shell();
    let sidecar = shell.sidecar("yt-dlp").map_err(|e| format!("Failed to create sidecar: {}", e))?;

    let output_path = PathBuf::from(&options.output_dir);
    std::fs::create_dir_all(&output_path)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    let filename_template = options.filename_template.unwrap_or_else(|| "%(title)s [%(resolution)s].%(ext)s".to_string());
    let output_template = output_path.join(filename_template).to_string_lossy().to_string();

    // Build yt-dlp format selector based on quality
    // Use yt-dlp's format selection syntax to auto-merge video+audio
    let format_selector = match options.quality.as_str() {
        "best" => "bestvideo+bestaudio/best".to_string(),
        q if q.ends_with('p') => {
            let height = q.trim_end_matches('p').parse::<u32>().unwrap_or(1080);
            format!("bestvideo[height<={}]+bestaudio/best[height<={}]", height, height)
        }
        _ => "bestvideo+bestaudio/best".to_string(),
    };

    eprintln!(
        "[AeroFetch] Starting download: quality={} selector={} dir={}",
        options.quality, format_selector, options.output_dir
    );

    let args = vec![
        "-f".to_string(),
        format_selector,
        "-o".to_string(),
        output_template,
        "--newline".to_string(),
        "--progress-template".to_string(),
        "download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s".to_string(),
        "--no-warnings".to_string(),
        "--no-playlist".to_string(),
        "--merge-output-format".to_string(),
        "mp4".to_string(),
        "--exec".to_string(),
        "after_move:echo __AEROFETCH_FINAL__:{}".to_string(),
        options.url.clone(),
    ];

    let (mut rx, _child) = sidecar
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;

    let mut final_path = String::new();
    let mut last_error = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                let line = String::from_utf8_lossy(&line);

                // Capture final path marker
                if line.contains("__AEROFETCH_FINAL__:") {
                    let parts: Vec<&str> = line.split("__AEROFETCH_FINAL__:").collect();
                    if parts.len() >= 2 {
                        final_path = parts[1].trim().trim_matches('\'').trim_matches('"').to_string();
                    }
                } else {
                    parse_progress_line(&line, &app);

                    // Fallback path extraction from log lines
                    if line.contains("Destination:") || line.contains("Merging formats into") {
                        if let Some(path) = extract_output_path(&line) {
                            final_path = path;
                        }
                    }
                }
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                let line = String::from_utf8_lossy(&line);
                let trimmed = line.trim();
                if trimmed.contains("ERROR") || trimmed.contains("error") {
                    last_error = trimmed.to_string();
                }
                eprintln!("yt-dlp stderr: {}", trimmed);
            }
            tauri_plugin_shell::process::CommandEvent::Error(err) => {
                return Err(format!("Download error: {}", err));
            }
            tauri_plugin_shell::process::CommandEvent::Terminated(status) => {
                if status.code != Some(0) {
                    if last_error.is_empty() {
                        return Err(format!("Download failed with exit code: {:?}", status.code));
                    } else {
                        return Err(last_error);
                    }
                }
            }
            _ => {}
        }
    }

    if final_path.is_empty() {
        final_path = output_path.to_string_lossy().to_string();
    }

    eprintln!("[AeroFetch] Download finished: {}", final_path);
    Ok(final_path)
}

fn parse_progress_line<R: Runtime>(line: &str, app: &tauri::AppHandle<R>) {
    if line.contains('|') {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() >= 5 {
            let percent_str = parts[0].trim().replace('%', "");
            let speed = parts[1].trim().to_string();
            let eta = parts[2].trim().to_string();
            let downloaded = parts[3].trim().parse::<u64>().ok();
            let total = parts[4].trim().parse::<u64>().ok()
                .or_else(|| parts.get(5).and_then(|p| p.trim().parse::<u64>().ok()));

            let percent = percent_str.parse::<f64>().ok();

            let progress = DownloadProgress {
                status: "downloading".to_string(),
                percent,
                speed: Some(speed),
                eta: Some(eta),
                downloaded_bytes: downloaded,
                total_bytes: total,
            };

            let _ = app.emit("download-progress", progress);
        }
    }
}

fn extract_output_path(line: &str) -> Option<String> {
    if line.contains("Destination:") {
        line.split("Destination:").nth(1).map(|s| s.trim().to_string())
    } else if line.contains("Merging formats into") {
        line.split("Merging formats into").nth(1).map(|s| s.trim().trim_matches('"').to_string())
    } else {
        None
    }
}

#[tauri::command]
async fn select_download_dir<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_dialog::FilePath;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_title("Select Download Directory")
        .pick_folder(move |result: Option<FilePath>| {
            let _ = tx.send(result.map(|p| p.to_string()));
        });

    let result = rx.await.map_err(|e| format!("Dialog error: {}", e))?;
    Ok(result)
}

#[tauri::command]
fn get_default_download_dir() -> String {
    dirs::download_dir()
        .or_else(|| dirs::home_dir())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_formats_builds_quality_keys() {
        let json: serde_json::Value = serde_json::json!({
            "id": "test123",
            "title": "Test Video",
            "formats": [
                {"format_id": "137", "ext": "mp4", "resolution": "1920x1080", "height": 1080, "vcodec": "avc1.640028", "acodec": "none", "fps": 30, "format_note": "1080p"},
                {"format_id": "136", "ext": "mp4", "resolution": "1280x720", "height": 720, "vcodec": "avc1.4d401f", "acodec": "none", "fps": 30, "format_note": "720p"},
                {"format_id": "135", "ext": "mp4", "resolution": "854x480", "height": 480, "vcodec": "avc1.4d401e", "acodec": "none", "fps": 30, "format_note": "480p"},
                {"format_id": "140", "ext": "m4a", "resolution": null, "height": null, "vcodec": "none", "acodec": "mp4a.40.2", "fps": null},
                {"format_id": "18", "ext": "mp4", "resolution": "640x360", "height": 360, "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "fps": 30, "format_note": "360p"}
            ]
        });

        let formats = parse_formats(&json);
        let keys: Vec<&str> = formats.iter().map(|f| f.quality_key.as_str()).collect();
        assert_eq!(keys, vec!["best", "1080p", "720p", "480p", "360p"]);
        assert_eq!(formats[0].format_id, "best");
        assert!(formats.iter().all(|f| f.has_video));
        assert!(formats.iter().all(|f| !f.quality_label.is_empty()));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Startup self-diagnostics: verify the yt-dlp sidecar is available
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match handle.shell().sidecar("yt-dlp") {
                    Ok(cmd) => match cmd.args(["--version"]).output().await {
                        Ok(out) => {
                            let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
                            if out.status.success() {
                                eprintln!("[AeroFetch] ✓ yt-dlp sidecar ready (version {})", ver);
                            } else {
                                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                                eprintln!("[AeroFetch] ✗ yt-dlp sidecar failed: {}", err);
                            }
                        }
                        Err(e) => eprintln!("[AeroFetch] ✗ yt-dlp sidecar could not run: {}", e),
                    },
                    Err(e) => eprintln!("[AeroFetch] ✗ yt-dlp sidecar could not resolve: {}", e),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_video_info,
            download_video,
            select_download_dir,
            get_default_download_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}