-- M0 初始表结构：只承载音频会话、录音与分析结果元数据。
-- 音频/MIDI 等大文件存对象/文件存储，数据库只保存路径。

CREATE TABLE IF NOT EXISTS audio_sessions (
    id           TEXT PRIMARY KEY,
    mode         TEXT NOT NULL,              -- 'streaming' | 'file'
    sample_rate  INTEGER NOT NULL DEFAULT 16000,
    status       TEXT NOT NULL DEFAULT 'active', -- active | closed
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recordings (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES audio_sessions(id),
    file_path    TEXT NOT NULL,              -- File/Object Storage 路径
    duration     REAL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analysis_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id  TEXT NOT NULL REFERENCES recordings(id),
    kind          TEXT NOT NULL,             -- pitch | notes | transcribe | performance ...
    source        TEXT NOT NULL,             -- realtime | high_quality
    payload       TEXT NOT NULL,             -- 结构化 JSON（MusicEvent / 指标）
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id);
CREATE INDEX IF NOT EXISTS idx_analysis_recording ON analysis_results(recording_id);
