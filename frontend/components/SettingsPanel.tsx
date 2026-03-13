"use client";

import { X, UploadCloud, CheckCircle2, XCircle, ChevronDown, ChevronUp, ExternalLink, FileJson } from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { TTSProvider } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

const PROVIDERS: { value: TTSProvider; label: string; description: string }[] = [
  { value: "gemini", label: "Google Gemini (ADC)", description: "Cần service account JSON" },
  { value: "openai", label: "OpenAI TTS", description: "Cần OPENAI_API_KEY" },
  { value: "minimax", label: "MiniMax", description: "Cần API key + Group ID" },
  { value: "xtts", label: "Local XTTS (Vietnamese)", description: "thivux/XTTS-v2 · Cần Coqui TTS server" },
  { value: "edge", label: "Microsoft Edge TTS", description: "Miễn phí · Không cần API key" },
  { value: "gtranslate", label: "Google Translate (dự phòng)", description: "Không cần API key, chất lượng thấp" },
];

const OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const GEMINI_VOICES = [
  "vi-VN-Neural2-A",
  "vi-VN-Neural2-B",
  "vi-VN-Neural2-C",
  "vi-VN-Neural2-D",
  "vi-VN-Standard-A",
  "vi-VN-Standard-B",
];

const MINIMAX_VOICES = [
  "male-qn-qingse",
  "female-shaonv",
  "male-qn-jingying",
  "female-yujie",
  "male-qn-badao",
  "female-tianmei",
];

// ─── Gemini credentials drag-and-drop section ────────────────────────────────

type CredStatus = { configured: boolean; client_email?: string; project_id?: string } | null;

function GeminiCredentialsUploader() {
  const [dragging, setDragging]     = useState(false);
  const [uploading, setUploading]   = useState(false);
  const [status, setStatus]         = useState<CredStatus>(null);
  const [error, setError]           = useState<string | null>(null);
  const [showGuide, setShowGuide]   = useState(false);
  const fileInputRef                = useRef<HTMLInputElement>(null);

  // Fetch current credential status on mount
  useEffect(() => {
    fetch("/api/auth/credentials-status")
      .then((r) => r.json())
      .then((d) => setStatus(d))
      .catch(() => {});
  }, []);

  const uploadFile = useCallback(async (file: File) => {
    if (!file.name.endsWith(".json")) {
      setError("Chỉ chấp nhận file .json");
      return;
    }
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/auth/upload-credentials", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setStatus({ configured: true, client_email: data.client_email, project_id: data.project_id });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setUploading(false);
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }, [uploadFile]);

  return (
    <div className="flex flex-col gap-3">
      {/* Status badge */}
      {status?.configured ? (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2.5"
          style={{ background: 'rgba(0,255,150,0.07)', border: '1px solid rgba(0,255,150,0.25)' }}>
          <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" style={{ color: '#00ff96' }} />
          <div className="text-xs">
            <p className="font-medium" style={{ color: '#00ff96' }}>Đã kết nối Google Cloud</p>
            <p style={{ color: 'rgba(0,255,150,0.6)' }} className="truncate">{status.client_email}</p>
            <p style={{ color: 'rgba(0,255,150,0.4)' }}>Project: {status.project_id}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2"
          style={{ background: 'rgba(255,160,0,0.07)', border: '1px solid rgba(255,160,0,0.25)' }}>
          <XCircle size={15} className="flex-shrink-0" style={{ color: '#ffaa33' }} />
          <p className="text-xs" style={{ color: '#ffaa33' }}>Chưa cấu hình — cần upload service account JSON</p>
        </div>
      )}

      {/* Drag-and-drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 cursor-pointer transition-all select-none ${uploading ? "opacity-60 pointer-events-none" : ""}`}
        style={dragging
          ? { borderColor: '#7c3aed', background: 'rgba(124,58,237,0.1)', transform: 'scale(1.01)' }
          : { borderColor: 'rgba(124,58,237,0.3)', background: 'transparent' }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); }}
        />
        {uploading ? (
          <>
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
            <p className="text-xs" style={{ color: '#8888b0' }}>Đang tải lên…</p>
          </>
        ) : (
          <>
            <div className="p-3 rounded-full" style={{ background: 'rgba(124,58,237,0.15)' }}>
              {dragging
                ? <FileJson size={22} style={{ color: '#a78bfa' }} />
                : <UploadCloud size={22} style={{ color: '#6d6d9a' }} />
              }
            </div>
            <p className="text-sm font-medium" style={{ color: '#c7c7e0' }}>
              {dragging ? "Thả file vào đây" : "Kéo thả file JSON vào đây"}
            </p>
            <p className="text-xs" style={{ color: '#6d6d9a' }}>hoặc click để chọn file</p>
            <p className="text-xs mt-1 font-mono" style={{ color: '#4a4a7a' }}>service_account.json</p>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs rounded-lg px-3 py-2"
          style={{ color: '#ff6b6b', background: 'rgba(255,50,50,0.07)', border: '1px solid rgba(255,50,50,0.25)' }}>
          <XCircle size={13} className="flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Collapsible step-by-step guide */}
      <button
        onClick={() => setShowGuide((v) => !v)}
        className="flex items-center justify-between w-full text-xs py-1 transition-colors"
        style={{ color: '#a78bfa' }}
      >
        <span className="font-medium">Hướng dẫn lấy service account JSON</span>
        {showGuide ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {showGuide && (
        <div className="rounded-xl px-4 py-4 text-xs flex flex-col gap-3"
          style={{ background: 'rgba(124,58,237,0.07)', border: '1px solid rgba(124,58,237,0.2)', color: '#8888b0' }}>
          <div className="flex items-center gap-2 rounded-lg px-3 py-2"
            style={{ color: '#ffcc44', background: 'rgba(255,200,0,0.07)', border: '1px solid rgba(255,200,0,0.2)' }}>
            <span className="text-base">⚠️</span>
            <span>Cần bật <strong>Cloud Text-to-Speech API</strong> trên project của bạn. Miễn phí 1 triệu ký tự/tháng đầu.</span>
          </div>

          {[
            { n: 1, text: "Truy cập Google Cloud Console", href: "https://console.cloud.google.com/" },
            { n: 2, text: 'Tạo project mới (hoặc chọn project hiện có)', href: null },
            { n: 3, text: "Bật API: APIs & Services → Enable APIs → tìm \"Cloud Text-to-Speech API\" → Enable", href: "https://console.cloud.google.com/apis/library/texttospeech.googleapis.com" },
            { n: 4, text: 'IAM & Admin → Service Accounts → Create Service Account', href: "https://console.cloud.google.com/iam-admin/serviceaccounts" },
            { n: 5, text: 'Điền tên bất kỳ → Grant role: "Cloud Text-to-Speech Editor" → Done', href: null },
            { n: 6, text: 'Click vào service account → Keys → Add Key → Create new key → JSON → Download', href: null },
            { n: 7, text: 'Upload file JSON vừa tải về vào ô trên ↑', href: null },
          ].map(({ n, text, href }) => (
            <div key={n} className="flex items-start gap-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold mt-0.5"
                style={{ background: '#7c3aed', color: '#fff' }}>
                {n}
              </span>
              <span className="leading-relaxed flex-1">
                {text}
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 ml-1.5 hover:underline"
                    style={{ color: '#a78bfa' }}
                  >
                    Mở <ExternalLink size={11} />
                  </a>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ProviderConfig ───────────────────────────────────────────────────────────

function ProviderConfig({
  provider,
  ttsSettings,
  sl,
}: {
  provider: TTSProvider
  ttsSettings: { geminiVoice: string; openaiApiKey: string; openaiVoice: string; minimaxApiKey: string; minimaxGroupId: string; minimaxVoiceId: string; xttsEndpoint: string }
  sl: (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void
}) {
  const inputStyle = {
    background: '#12122a',
    border: '1px solid rgba(124,58,237,0.3)',
    color: '#c7c7e0',
  };
  const labelStyle = { color: '#6d6d9a' };

  switch (provider) {
    case 'gemini':
      return (
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <label className="text-xs mb-1 block" style={labelStyle}>Giọng</label>
            <select
              value={ttsSettings.geminiVoice}
              onChange={sl('geminiVoice')}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ ...inputStyle, borderColor: 'rgba(124,58,237,0.3)' }}
            >
              {GEMINI_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <GeminiCredentialsUploader />
        </div>
      )
    case 'openai':
      return (
        <div className="mt-3 flex flex-col gap-2">
          <div>
            <label className="text-xs mb-1 block" style={labelStyle}>API Key</label>
            <input
              type="password"
              value={ttsSettings.openaiApiKey}
              onChange={sl('openaiApiKey')}
              placeholder="sk-..."
              className="w-full rounded-lg px-3 py-2 text-xs focus:outline-none"
              style={{ ...inputStyle, '--placeholder-color': '#4a4a7a' } as React.CSSProperties}
            />
          </div>
          <div>
            <label className="text-xs mb-1 block" style={labelStyle}>Giọng</label>
            <select
              value={ttsSettings.openaiVoice}
              onChange={sl('openaiVoice')}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={inputStyle}
            >
              {OPENAI_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>
      )
    case 'minimax':
      return (
        <div className="mt-3 flex flex-col gap-2">
          <div>
            <label className="text-xs mb-1 block" style={labelStyle}>API Key</label>
            <input
              type="password"
              value={ttsSettings.minimaxApiKey}
              onChange={sl('minimaxApiKey')}
              placeholder="MiniMax API key"
              className="w-full rounded-lg px-3 py-2 text-xs focus:outline-none"
              style={inputStyle}
            />
          </div>
          <div>
            <label className="text-xs mb-1 block" style={labelStyle}>Group ID</label>
            <input
              type="text"
              value={ttsSettings.minimaxGroupId}
              onChange={sl('minimaxGroupId')}
              placeholder="MiniMax Group ID"
              className="w-full rounded-lg px-3 py-2 text-xs focus:outline-none"
              style={inputStyle}
            />
          </div>
          <div>
            <label className="text-xs mb-1 block" style={labelStyle}>Giọng</label>
            <select
              value={ttsSettings.minimaxVoiceId}
              onChange={sl('minimaxVoiceId')}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={inputStyle}
            >
              {MINIMAX_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>
      )
    case 'xtts':
      return (
        <div className="mt-3">
          <label className="text-xs mb-1 block" style={labelStyle}>Endpoint URL</label>
          <input
            type="url"
            value={ttsSettings.xttsEndpoint}
            onChange={sl('xttsEndpoint')}
            placeholder="http://localhost:5002"
            className="w-full rounded-lg px-3 py-2 text-xs focus:outline-none"
            style={inputStyle}
          />
        </div>
      )
    case 'edge':
      return (
        <div className="mt-3 rounded-lg p-3"
          style={{ background: 'rgba(0,255,255,0.05)', border: '1px solid rgba(0,255,255,0.2)' }}>
          <p className="text-xs font-medium" style={{ color: '#00ffff' }}>
            ✓ Edge TTS — <span style={{ color: 'rgba(0,255,255,0.7)' }}>vi-VN-NamMinhNeural</span>
          </p>
          <p className="text-xs mt-1" style={{ color: '#4a4a7a' }}>
            Miễn phí · Không cần API key · Không giới hạn ký tự
          </p>
        </div>
      )
    case 'gtranslate':
      return (
        <p className="mt-2 text-xs italic" style={{ color: '#4a4a7a' }}>
          Không cần cấu hình — dùng làm dự phòng cuối cùng
        </p>
      )
    default:
      return null
  }
}

// ─── Main SettingsPanel ───────────────────────────────────────────────────────

export default function SettingsPanel() {
  const { ttsSettings, updateTTSSettings, toggleSettingsPanel } = useAppStore();

  const sl = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateTTSSettings({ [field]: e.target.value });

  const slNum = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    updateTTSSettings({ [field]: parseFloat(e.target.value) });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4"
        style={{ borderBottom: '1px solid rgba(124,58,237,0.15)' }}>
        <h2 className="text-base font-semibold" style={{ color: '#a78bfa' }}>Cài đặt TTS</h2>
        <button
          onClick={toggleSettingsPanel}
          className="p-1.5 rounded transition-colors"
          style={{ color: '#6d6d9a' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#a78bfa'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(124,58,237,0.15)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#6d6d9a'; (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-6">
        {/* Provider */}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: '#a78bfa' }}>
            Nhà cung cấp TTS
          </h3>
          <div className="flex flex-col gap-2">
            {PROVIDERS.map((p) => {
              const isActive = ttsSettings.preferredProvider === p.value
              return (
                <div
                  key={p.value}
                  className="rounded-lg border p-3 transition-colors"
                  style={isActive
                    ? { border: '1px solid #7c3aed', background: 'rgba(124,58,237,0.12)', boxShadow: '0 0 8px rgba(124,58,237,0.2)' }
                    : { border: '1px solid rgba(124,58,237,0.15)', background: 'transparent' }}
                >
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="provider"
                      value={p.value}
                      checked={isActive}
                      onChange={() => updateTTSSettings({ preferredProvider: p.value })}
                      className="mt-0.5 accent-violet-500"
                    />
                    <div>
                      <p className="text-sm font-medium" style={{ color: isActive ? '#c7c7e0' : '#8888b0' }}>{p.label}</p>
                      <p className="text-xs" style={{ color: '#4a4a7a' }}>{p.description}</p>
                    </div>
                  </label>
                  {isActive && (
                    <ProviderConfig
                      provider={p.value}
                      ttsSettings={ttsSettings}
                      sl={sl}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </section>

        {/* Speed & Pitch */}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: '#a78bfa' }}>
            Tốc độ &amp; Cao độ
          </h3>
          <div className="flex flex-col gap-4">
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-sm" style={{ color: '#8888b0' }}>Tốc độ đọc</label>
                <span className="text-sm font-mono" style={{ color: '#a78bfa' }}>{ttsSettings.speed.toFixed(1)}×</span>
              </div>
              <input
                type="range" min="0.5" max="2.0" step="0.1"
                value={ttsSettings.speed}
                onChange={slNum("speed")}
                className="w-full accent-violet-500"
              />
              <div className="flex justify-between mt-0.5">
                <span className="text-xs" style={{ color: '#4a4a7a' }}>0.5×</span>
                <span className="text-xs" style={{ color: '#4a4a7a' }}>2.0×</span>
              </div>
            </div>
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-sm" style={{ color: '#8888b0' }}>Cao độ (Gemini)</label>
                <span className="text-sm font-mono" style={{ color: '#a78bfa' }}>{ttsSettings.pitch.toFixed(1)}</span>
              </div>
              <input
                type="range" min="-10" max="10" step="0.5"
                value={ttsSettings.pitch}
                onChange={slNum("pitch")}
                className="w-full accent-violet-500"
              />
              <div className="flex justify-between mt-0.5">
                <span className="text-xs" style={{ color: '#4a4a7a' }}>–10</span>
                <span className="text-xs" style={{ color: '#4a4a7a' }}>+10</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="px-5 py-3 text-xs text-center"
        style={{ borderTop: '1px solid rgba(124,58,237,0.15)', color: '#4a4a7a' }}>
        Cài đặt được lưu tự động vào localStorage
      </div>
    </div>
  );
}
