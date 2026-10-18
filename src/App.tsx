import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

interface VideoFormat {
  format_id: string;
  ext: string;
  resolution: string | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  filesize: number | null;
  format_note: string | null;
  quality_label: string;
  quality_key: string;
  height: number | null;
  has_video: boolean;
  has_audio: boolean;
}

interface VideoInfo {
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
  formats: VideoFormat[];
}

interface DownloadProgress {
  status: string;
  percent: number | null;
  speed: string | null;
  eta: string | null;
  downloaded_bytes: number | null;
  total_bytes: number | null;
}

interface DownloadOptions {
  url: string;
  quality: string;
  output_dir: string;
  filename_template?: string;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "Unknown";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "";
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function isValidYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    return (
      host === "youtube.com" ||
      host === "youtu.be" ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube.com") ||
      host.endsWith(".youtu.be")
    );
  } catch {
    return false;
  }
}

function App() {
  const [url, setUrl] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [selectedQuality, setSelectedQuality] = useState<string>("");
  const [downloadDir, setDownloadDir] = useState<string>("");
  const [showQualityModal, setShowQualityModal] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [completedFile, setCompletedFile] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  // Load default download directory on mount
  useEffect(() => {
    invoke<string>("get_default_download_dir")
      .then(dir => setDownloadDir(dir))
      .catch(() => {});
  }, []);

  // Listen for download progress events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<DownloadProgress>("download-progress", (event) => {
      setProgress(event.payload);
    }).then(un => { unlisten = un; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Accessibility: move focus into the dialog when it opens, restore it on
  // close, and let Escape dismiss the dialog (WCAG 2.1.1 / 2.1.2 / 2.4.3)
  useEffect(() => {
    if (!showQualityModal) return;

    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusFrame = requestAnimationFrame(() => modalRef.current?.focus());

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowQualityModal(false);
      }
    };
    document.addEventListener("keydown", handleEscape);

    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape);
      lastFocusedRef.current?.focus?.();
    };
  }, [showQualityModal]);

  // Accessibility: keep Tab / Shift+Tab focus cycling inside the open dialog
  const trapModalFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !modalRef.current) return;
    const focusable = modalRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === modalRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const fetchVideoInfo = async (videoUrl: string) => {
    const trimmed = videoUrl.trim();
    if (!trimmed) return;

    if (!isValidYouTubeUrl(trimmed)) {
      setError("Please enter a valid YouTube URL (video, short, or playlist)");
      return;
    }

    setIsFetching(true);
    setError(null);
    setVideoInfo(null);
    setSelectedQuality("");
    setCompletedFile(null);
    setProgress(null);

    try {
      const info = await invoke<VideoInfo>("get_video_info", { url: trimmed });
      setVideoInfo(info);
      if (info.formats.length > 0) {
        setSelectedQuality(info.formats[0].quality_key);
      }
      // Ask quality before download
      setShowQualityModal(true);
    } catch (err) {
      setError(err as string);
    } finally {
      setIsFetching(false);
    }
  };

  // Auto-fetch when a link is pasted
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").trim();
    if (pasted && isValidYouTubeUrl(pasted)) {
      // Update input value and start fetching automatically
      setTimeout(() => {
        setUrl(pasted);
        fetchVideoInfo(pasted);
      }, 0);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isFetching) {
      fetchVideoInfo(url);
    }
  };

  const handleSelectDir = async () => {
    try {
      const dir = await invoke<string | null>("select_download_dir");
      if (dir) setDownloadDir(dir);
    } catch (err) {
      setError(err as string);
    }
  };

  const handleDownload = async () => {
    if (!videoInfo || !selectedQuality || !downloadDir) {
      setError("Missing required information");
      return;
    }

    // Close modal, show progress on main screen
    setShowQualityModal(false);
    setIsDownloading(true);
    setProgress(null);
    setError(null);
    setCompletedFile(null);

    const options: DownloadOptions = {
      url: url.trim(),
      quality: selectedQuality,
      output_dir: downloadDir,
      filename_template: "%(title)s [%(resolution)s].%(ext)s",
    };

    try {
      const result = await invoke<string>("download_video", { options });
      setCompletedFile(result);
      setProgress({ status: "completed", percent: 100, speed: null, eta: null, downloaded_bytes: null, total_bytes: null });
    } catch (err) {
      setError(err as string);
      setProgress(null);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleShowInFolder = async () => {
    if (completedFile) {
      try {
        await revealItemInDir(completedFile);
      } catch (err) {
        setError(`Could not open folder: ${err}`);
      }
    }
  };

  const handleNewDownload = () => {
    setUrl("");
    setVideoInfo(null);
    setSelectedQuality("");
    setProgress(null);
    setCompletedFile(null);
    setError(null);
  };

  // Single source of truth for the polite live region: announced for
  // fetching, download progress, completion, and errors (WCAG 4.1.3)
  const liveStatus = error
    ? `Error: ${error}`
    : isFetching
      ? "Fetching video information…"
      : isDownloading
        ? progress?.percent != null
          ? `Downloading: ${Math.round(progress.percent)} percent complete${
              progress.speed ? `, speed ${progress.speed}` : ""
            }${progress.eta ? `, ${progress.eta} remaining` : ""}`
          : "Download starting…"
        : completedFile
          ? `Download complete. Saved to ${completedFile}`
          : "";

  return (
    <main className="container">
      {/* Visually hidden polite live region announcing status changes */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveStatus}
      </div>

      <header className="header">
        <h1>AeroFetch</h1>
        <p className="subtitle">YouTube Video Downloader</p>
      </header>

      <section className="section url-section">
        <div className="input-group">
          <label htmlFor="url-input">YouTube URL</label>
          <div className="url-input-wrapper">
            <input
              id="url-input"
              type="text"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              placeholder="Paste a YouTube link here..."
              aria-describedby="url-hint"
              autoComplete="url"
              spellCheck={false}
              disabled={isFetching || isDownloading}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => fetchVideoInfo(url)}
              disabled={isFetching || isDownloading || !url.trim()}
              aria-label={isFetching ? "Fetching video information" : "Fetch video information"}
              aria-busy={isFetching}
            >
              {isFetching ? "Fetching..." : "Fetch"}
            </button>
          </div>
          <p id="url-hint" className="hint">Paste a link and quality options will appear automatically</p>
          {error && <p className="error-message">{error}</p>}
        </div>
      </section>

      {isFetching && (
        <section className="section centered">
          <div className="spinner" aria-hidden="true"></div>
          <p>Getting video info...</p>
        </section>
      )}

      {/* Download progress */}
      {isDownloading && progress && (
        <section className="section">
          <div className="progress-container">
            <div className="download-title">
              {videoInfo && <span>Downloading: {videoInfo.title}</span>}
            </div>
            <div
              className="progress-bar"
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent ?? undefined}
              aria-valuetext={progress.percent != null ? `${progress.percent.toFixed(1)}% complete` : "Starting"}
            >
              <div
                className="progress-fill"
                style={{ width: `${progress.percent ?? 0}%` }}
              ></div>
            </div>
            <div className="progress-info">
              <span>{progress.percent ? `${progress.percent.toFixed(1)}%` : "Starting..."}</span>
              {progress.speed && (
                <span><span aria-hidden="true">⚡</span> {progress.speed}</span>
              )}
              {progress.eta && (
                <span><span aria-hidden="true">⏳</span> ETA: {progress.eta}</span>
              )}
            </div>
            {progress.downloaded_bytes && progress.total_bytes && (
              <div className="progress-bytes">
                {formatFileSize(progress.downloaded_bytes)} / {formatFileSize(progress.total_bytes)}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Download complete */}
      {completedFile && (
        <section className="section">
          <div className="success-message">
            <p className="success-title"><span aria-hidden="true">✅</span> Download complete!</p>
            <p className="success-path">{completedFile}</p>
            <div className="success-actions">
              <button type="button" className="btn btn-primary" onClick={handleShowInFolder}>
                Show in Folder
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleNewDownload}>
                Download Another
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Quality selection modal */}
      {showQualityModal && videoInfo && (
        <div className="modal-overlay" onClick={() => setShowQualityModal(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quality-dialog-title"
            tabIndex={-1}
            ref={modalRef}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={trapModalFocus}
          >
            <div className="modal-header">
              <h2 id="quality-dialog-title">Choose Quality</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowQualityModal(false)}
                disabled={isDownloading}
                aria-label="Close quality selection dialog"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>

            <div className="modal-video-info">
              {videoInfo.thumbnail && (
                <img
                  src={videoInfo.thumbnail}
                  alt={`${videoInfo.title} thumbnail`}
                  className="thumbnail"
                />
              )}
              <div className="video-details">
                <h3>{videoInfo.title}</h3>
                <div className="meta">
                  {videoInfo.uploader && (
                    <span><span aria-hidden="true">👤</span> {videoInfo.uploader}</span>
                  )}
                  {videoInfo.duration && (
                    <span><span aria-hidden="true">⏱️</span> {formatDuration(videoInfo.duration)}</span>
                  )}
                </div>
              </div>
            </div>

            <div className="quality-options" role="group" aria-label="Video quality options">
              {videoInfo.formats.map((format) => {
                const isSelected = selectedQuality === format.quality_key;
                const labelParts = [
                  format.quality_label,
                  format.ext.toUpperCase(),
                  format.filesize ? formatFileSize(format.filesize) : null,
                  format.fps ? `${format.fps} fps` : null,
                ].filter(Boolean);
                return (
                  <button
                    key={format.format_id}
                    type="button"
                    className={`quality-btn ${isSelected ? "selected" : ""}`}
                    onClick={() => setSelectedQuality(format.quality_key)}
                    aria-pressed={isSelected}
                    aria-label={labelParts.join(", ")}
                  >
                    <div className="quality-main">
                      <span className="quality-label">{format.quality_label}</span>
                      <span className="quality-ext">{format.ext.toUpperCase()}</span>
                    </div>
                    <div className="quality-meta" aria-hidden="true">
                      {format.filesize && <span>📦 {formatFileSize(format.filesize)}</span>}
                      {format.fps && <span>🎞️ {format.fps}fps</span>}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="modal-location">
              <label htmlFor="download-dir">Save to:</label>
              <div className="dir-input-wrapper">
                <input id="download-dir" type="text" value={downloadDir} readOnly />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleSelectDir}
                  aria-label="Browse for download folder"
                >
                  Browse
                </button>
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-download"
                onClick={handleDownload}
                disabled={!selectedQuality || !downloadDir}
                aria-label="Download selected video"
              >
                <span aria-hidden="true">⬇</span> Download
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="footer">
        <p>Built with Tauri + React + yt-dlp</p>
      </footer>
    </main>
  );
}

export default App;
