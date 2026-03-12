"use client";

import { X, UploadCloud, CheckCircle2, XCircle, ChevronDown, ChevronUp, ExternalLink, FileJson } from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { TTSProvider } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

const PROVIDERS: { value: TTSProvider; label: string; description: string }[] = [
  { value: "gemini", label: "Google Gemini (ADC)", description: "Cần service account JSON" },
  { value: "openai", label: "OpenAI TTS", description: "Cần OPENAI_API_KEY" },
  { value: "minimax", label: "MiniMax", description: "Cần API key + Group ID" },
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
        <div className="flex items-start gap-2 bg-green-900/30 border border-green-700/50 rounded-lg px-3 py-2.5">
          <CheckCircle2 size={16} className="text-green-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs">
            <p className="text-green-300 font-medium">Đã kết nối Google Cloud</p>
            <p className="text-green-500 truncate">{status.client_email}</p>
            <p className="text-green-600">Project: {status.project_id}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 bg-orange-900/20 border border-orange-700/40 rounded-lg px-3 py-2">
          <XCircle size={15} className="text-orange-400 flex-shrink-0" />
          <p className="text-xs text-orange-300">Chưa cấu hình — cần upload service account JSON</p>
        </div>
      )}

      {/* Drag-and-drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 cursor-pointer transition-all select-none
          ${dragging
            ? "border-indigo-400 bg-indigo-500/10 scale-[1.01]"
            : "border-gray-600 hover:border-indigo-500 hover:bg-indigo-500/5"
          } ${uploading ? "opacity-60 pointer-events-none" : ""}`}
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
            <div className="w-6 h-6 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-gray-400">Đang tải lên…</p>
          </>
        ) : (
          <>
            <div className="p-3 bg-gray-700/60 rounded-full">
              {dragging
                ? <FileJson size={22} className="text-indigo-400" />
                : <UploadCloud size={22} className="text-gray-400" />
              }
            </div>
            <p className="text-sm text-gray-300 font-medium">
              {dragging ? "Thả file vào đây" : "Kéo thả file JSON vào đây"}
            </p>
            <p className="text-xs text-gray-500">hoặc click để chọn file</p>
            <p className="text-xs text-gray-600 mt-1 font-mono">service_account.json</p>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-xs bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2">
          <XCircle size={13} className="flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Collapsible step-by-step guide */}
      <button
        onClick={() => setShowGuide((v) => !v)}
        className="flex items-center justify-between w-full text-xs text-indigo-400 hover:text-indigo-300 transition-colors py-1"
      >
        <span className="font-medium">Hướng dẫn lấy service account JSON</span>
        {showGuide ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {showGuide && (
        <div className="rounded-xl bg-gray-800/60 border border-gray-700 px-4 py-4 text-xs text-gray-300 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-yellow-400 bg-yellow-900/20 border border-yellow-700/30 rounded-lg px-3 py-2">
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
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-bold mt-0.5">
                {n}
              </span>
              <span className="leading-relaxed flex-1">
                {text}
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 ml-1.5 text-indigo-400 hover:underline"
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
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
        <h2 className="text-base font-semibold text-white">Cài đặt TTS</h2>
        <button
          onClick={toggleSettingsPanel}
          className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-6">
        {/* Provider */}
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Nhà cung cấp TTS
          </h3>
          <div className="flex flex-col gap-2">
            {PROVIDERS.map((p) => (
              <label
                key={p.value}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  ttsSettings.preferredProvider === p.value
                    ? "border-indigo-500 bg-indigo-600/10"
                    : "border-gray-700 hover:border-gray-600"
                }`}
              >
                <input
                  type="radio"
                  name="provider"
                  value={p.value}
                  checked={ttsSettings.preferredProvider === p.value}
                  onChange={() => updateTTSSettings({ preferredProvider: p.value })}
                  className="mt-0.5 accent-indigo-500"
                />
                <div>
                  <p className="text-sm font-medium text-white">{p.label}</p>
                  <p className="text-xs text-gray-500">{p.description}</p>
                </div>
              </label>
            ))}
          </div>
        </section>

        {/* Speed & Pitch */}
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Tốc độ & Cao độ
          </h3>
          <div className="flex flex-col gap-4">
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-sm text-gray-300">Tốc độ đọc</label>
                <span className="text-sm text-indigo-400 font-mono">{ttsSettings.speed.toFixed(1)}×</span>
              </div>
              <input
                type="range" min="0.5" max="2.0" step="0.1"
                value={ttsSettings.speed}
                onChange={slNum("speed")}
                className="w-full accent-indigo-500"
              />
            </div>
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-sm text-gray-300">Cao độ (Gemini)</label>
                <span className="text-sm text-indigo-400 font-mono">{ttsSettings.pitch.toFixed(1)}</span>
              </div>
              <input
                type="range" min="-10" max="10" step="0.5"
                value={ttsSettings.pitch}
                onChange={slNum("pitch")}
                className="w-full accent-indigo-500"
              />
            </div>
          </div>
        </section>

        {/* Gemini voice + credentials */}
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Giọng Gemini (Google Cloud)
          </h3>
          <select
            value={ttsSettings.geminiVoice}
            onChange={sl("geminiVoice")}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500 mb-4"
          >
            {GEMINI_VOICES.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>

          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Xác thực Google Cloud
          </p>
          <GeminiCredentialsUploader />
        </section>

        {/* OpenAI */}
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            OpenAI TTS
          </h3>
          <div className="flex flex-col gap-2">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">API Key</label>
              <input
                type="password"
                value={ttsSettings.openaiApiKey}
                onChange={sl("openaiApiKey")}
                placeholder="sk-..."
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Giọng</label>
              <select
                value={ttsSettings.openaiVoice}
                onChange={sl("openaiVoice")}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
              >
                {OPENAI_VOICES.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* MiniMax */}
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            MiniMax TTS
          </h3>
          <div className="flex flex-col gap-2">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">API Key</label>
              <input
                type="password"
                value={ttsSettings.minimaxApiKey}
                onChange={sl("minimaxApiKey")}
                placeholder="MiniMax API key"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Group ID</label>
              <input
                type="text"
                value={ttsSettings.minimaxGroupId}
                onChange={sl("minimaxGroupId")}
                placeholder="MiniMax Group ID"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Giọng</label>
              <select
                value={ttsSettings.minimaxVoiceId}
                onChange={sl("minimaxVoiceId")}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
              >
                {MINIMAX_VOICES.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
          </div>
        </section>
      </div>

      <div className="px-5 py-3 border-t border-gray-700 text-xs text-gray-600 text-center">
        Cài đặt được lưu tự động vào localStorage
      </div>
    </div>
  );
}

