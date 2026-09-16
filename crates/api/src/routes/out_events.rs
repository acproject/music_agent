//! MusicEvent(proto) → WebSocket 出站 JSON（与需求第 24 节消息形状对齐）。
//!
//! 按事件类型把字段扁平化到顶层，前端无需感知 protobuf oneof。

use music_domain::v1::{music_event::Payload, MusicEvent, Source};
use serde_json::{json, Value};

fn source_name(source: i32) -> &'static str {
    match Source::try_from(source) {
        Ok(Source::Realtime) => "realtime",
        Ok(Source::HighQuality) => "high_quality",
        _ => "unspecified",
    }
}

pub fn music_event_json(ev: &MusicEvent) -> Value {
    let mut m = json!({
        "session_id": ev.session_id,
        "timestamp": ev.timestamp,
        "source": source_name(ev.source),
    });
    let obj = m.as_object_mut().expect("json object");

    match ev.payload.as_ref() {
        Some(Payload::Note(n)) => {
            obj.insert("type".into(), json!("note"));
            obj.insert("midi".into(), json!(n.midi));
            obj.insert("cents_offset".into(), json!(n.cents_offset));
            obj.insert("start".into(), json!(n.onset));
            obj.insert("duration".into(), json!(n.duration));
            obj.insert("velocity".into(), json!(n.velocity));
            obj.insert("confidence".into(), json!(n.confidence));
        }
        Some(Payload::Pitch(p)) => {
            obj.insert("type".into(), json!("pitch"));
            obj.insert("frequency_hz".into(), json!(p.frequency_hz));
            obj.insert("midi_cents".into(), json!(p.midi_cents));
            obj.insert("voiced".into(), json!(p.voiced));
            obj.insert("confidence".into(), json!(p.confidence));
        }
        Some(Payload::Beat(b)) => {
            obj.insert("type".into(), json!("beat"));
            obj.insert("onset".into(), json!(b.onset));
            obj.insert("beat".into(), json!(b.beat));
            obj.insert("bar".into(), json!(b.bar));
            obj.insert("bpm".into(), json!(b.bpm));
            obj.insert("timing_error_ms".into(), json!(b.timing_error_ms));
        }
        Some(Payload::Chord(c)) => {
            obj.insert("type".into(), json!("chord"));
            obj.insert("onset".into(), json!(c.onset));
            obj.insert("duration".into(), json!(c.duration));
            obj.insert("root".into(), json!(c.root));
            obj.insert("quality".into(), json!(c.quality));
            obj.insert("pitches".into(), json!(c.pitches));
            obj.insert("confidence".into(), json!(c.confidence));
        }
        Some(Payload::Tempo(t)) => {
            obj.insert("type".into(), json!("tempo"));
            obj.insert("time".into(), json!(t.time));
            obj.insert("bpm".into(), json!(t.bpm));
        }
        Some(Payload::Key(k)) => {
            obj.insert("type".into(), json!("key"));
            obj.insert("time".into(), json!(k.time));
            obj.insert("tonality".into(), json!(k.tonality));
            obj.insert("tonic_midi".into(), json!(k.tonic_midi));
            obj.insert("confidence".into(), json!(k.confidence));
        }
        Some(Payload::Measure(m)) => {
            obj.insert("type".into(), json!("measure"));
            obj.insert("index".into(), json!(m.index));
            obj.insert("start".into(), json!(m.start));
            obj.insert("time_signature".into(), json!([m.time_signature_num, m.time_signature_den]));
        }
        Some(Payload::Lyric(l)) => {
            obj.insert("type".into(), json!("lyric"));
            obj.insert("start".into(), json!(l.start));
            obj.insert("duration".into(), json!(l.duration));
            obj.insert("text".into(), json!(l.text));
        }
        Some(Payload::Dynamics(d)) => {
            obj.insert("type".into(), json!("dynamics"));
            obj.insert("time".into(), json!(d.time));
            obj.insert("velocity".into(), json!(d.velocity));
        }
        Some(Payload::Performance(p)) => {
            obj.insert("type".into(), json!("performance"));
            obj.insert("target_pitch".into(), json!(p.target_pitch));
            obj.insert("actual_pitch".into(), json!(p.actual_pitch));
            obj.insert("target_start".into(), json!(p.target_start));
            obj.insert("actual_start".into(), json!(p.actual_start));
            obj.insert("pitch_error_cents".into(), json!(p.pitch_error_cents));
            obj.insert("timing_error_ms".into(), json!(p.timing_error_ms));
            obj.insert("measure".into(), json!(p.measure));
            obj.insert("note_index".into(), json!(p.note_index));
        }
        None => {
            obj.insert("type".into(), json!("unknown"));
        }
    }

    m
}
