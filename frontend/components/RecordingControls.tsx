"use client";

import { useState, useCallback } from "react";
import { Mic, MicOff, FolderOpen, Save, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "react-toastify";
import { useAppStore } from "@/lib/store";

interface Props {
  text: string;
  chapterTitle: string;
}

export default function RecordingControls({ text, chapterTitle }: Props) {
  const {
    ttsSettings,
    recordingState,
    setRecording,
    setSaveDirectory,
    addSavedFile,
    setRecordingFormat,
  } = useAppStore();

  const [dirInput, setDirInput] = useState(recordingState.saveDirectory || "");
  const [saving, setSaving] = useState(false);

  const handleSaveNow = useCallback(async () => {
    const dir = dirInput.trim() || recordingState.saveDirectory;
    if (!dir) {
      toast.error("Hãy nhập đường dẫn thư mục lưu file");
      return;
    }

    setSaving(true);

    // 1. Synthesize audio
    let audioBlob: Blob;
    try {
      const body = {
        text: text.slice(0, 7500),
        preferred_provider: ttsSettings.preferredProvider,
        audio_format: recordingState.audioFormat,
        gemini_voice: ttsSettings.geminiVoice,
        gemini_language: ttsSettings.geminiLanguage,
        openai_voice: ttsSettings.openaiVoice,
        openai_model: ttsSettings.openaiModel,
        minimax_voice_id: ttsSettings.minimaxVoiceId,
        speed: ttsSettings.speed,
        pitch: ttsSettings.pitch,
      };
      const res = await fetch("/api/tts/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }
      audioBlob = await res.blob();
    } catch (e: unknown) {
      toast.error(`Tổng hợp giọng đọc thất bại: ${e instanceof Error ? e.message : e}`);
      setSaving(false);
      return;
    }

    // 2. Upload to backend save endpoint
    try {
      const formData = new FormData();
      formData.append("audio", audioBlob, `audio.${recordingState.audioFormat}`);
      formData.append("directory", dir);
      formData.append("filename", chapterTitle.replace(/[^a-zA-Z0-9À-ỹ_ ]/g, "_"));
      formData.append("audio_format", recordingState.audioFormat);

      const saveRes = await fetch("/api/audio/save", {
        method: "POST",
        body: formData,
      });
      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${saveRes.status}`);
      }
      const saved = await saveRes.json();
      addSavedFile(saved.saved_path);
      setSaveDirectory(dir);
      toast.success(`Đã lưu: ${saved.saved_path}`);
    } catch (e: unknown) {
      toast.error(`Lưu file thất bại: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  }, [text, chapterTitle, dirInput, recordingState, ttsSettings, addSavedFile, setSaveDirectory]);

  return (
    <div
      className="px-4 py-2 flex flex-col gap-2"
      style={{ borderTop: '1px solid rgba(124,58,237,0.2)' }}
    >
      {/* Directory picker row */}
      <div className="flex items-center gap-2">
        <FolderOpen size={13} className="flex-shrink-0" style={{ color: '#a78bfa' }} />
        <input
          type="text"
          value={dirInput}
          onChange={(e) => setDirInput(e.target.value)}
          placeholder="Đường dẫn thư mục lưu audio (e.g. C:\Audio)"
          className="flex-1 rounded px-2 py-1.5 text-xs focus:outline-none transition-colors"
          style={{
            background: '#12122a',
            border: '1px solid rgba(124,58,237,0.3)',
            color: '#c4b5fd',
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.65)')}
          onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.3)')}
        />

        {/* Format select */}
        <select
          value={recordingState.audioFormat}
          onChange={(e) => setRecordingFormat(e.target.value as "mp3" | "wav")}
          className="rounded px-2 py-1.5 text-xs focus:outline-none"
          style={{
            background: '#12122a',
            border: '1px solid rgba(124,58,237,0.3)',
            color: '#c4b5fd',
          }}
        >
          <option value="mp3" style={{ background: '#12122a' }}>MP3</option>
          <option value="wav" style={{ background: '#12122a' }}>WAV</option>
        </select>

        {/* Save button */}
        <button
          onClick={handleSaveNow}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: saving ? 'rgba(16,185,129,0.2)' : 'rgba(16,185,129,0.8)',
            color: '#fff',
            border: '1px solid rgba(16,185,129,0.5)',
            boxShadow: saving ? 'none' : '0 0 8px rgba(16,185,129,0.3)',
          }}
          title="Tổng hợp và lưu ngay"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          Lưu
        </button>
      </div>

      {/* Recently saved files */}
      {recordingState.savedFiles.length > 0 && (
        <div className="flex flex-col gap-0.5 max-h-20 overflow-y-auto">
          {recordingState.savedFiles.slice(0, 5).map((f, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs" style={{ color: '#6d6d9a' }}>
              <CheckCircle2 size={11} className="flex-shrink-0" style={{ color: '#10b981' }} />
              <span className="truncate">{f}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
