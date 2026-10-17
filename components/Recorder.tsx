'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { startComposition, type Composition } from '@/lib/compositor';

type Phase =
  | 'loading'
  | 'code'
  | 'idle'
  | 'recording'
  | 'preview'
  | 'sending'
  | 'sent';

const MAX_SECONDS = 5;

/**
 * نفضّل MP4 مباشرة (Safari + Chrome الحديث)، ثم WebM كخطة بديلة
 * (Firefox وبعض إصدارات Chrome القديمة).
 */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=h264',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMimeType(): string | null {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return null;
  for (const type of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* تجاهل الصيغة غير المدعومة */
    }
  }
  return '';
}

function friendlyError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'تم رفض إذن الكاميرا أو الميكروفون. اسمح بهما من إعدادات المتصفح لهذا الموقع ثم أعد المحاولة.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'لم نجد كاميرا أو ميكروفونًا متاحًا على هذا الجهاز.';
    case 'NotReadableError':
      return 'الكاميرا مستخدمة من تطبيق آخر. أغلق التطبيقات الأخرى ثم أعد المحاولة.';
    default:
      return 'تعذّر تشغيل الكاميرا. تأكد أنك تفتح الصفحة عبر https وبمتصفح حديث.';
  }
}

export default function Recorder({
  autoStart = false,
  fxVideoUrls,
}: {
  autoStart?: boolean;
  fxVideoUrls?: string[];
}) {
  /* ------------------------------ المراجع ------------------------------ */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const compRef = useRef<Composition | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startAtRef = useRef<number>(0);
  const mimeRef = useRef<string>('');
  const videoUrlRef = useRef<string | null>(null);
  const autoStartedRef = useRef(false);

  /* ------------------------------ الحالات ------------------------------ */
  const [phase, setPhase] = useState<Phase>('loading');
  const [remaining, setRemaining] = useState(MAX_SECONDS);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [cameraSize, setCameraSize] = useState<{ width: number; height: number } | null>(null);
  const [sending, setSending] = useState(false);

  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [serverReady, setServerReady] = useState<boolean | null>(null);

  /* --------------------------- أدوات مساعدة --------------------------- */
  const clearTimers = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timerRef.current = null;
    timeoutRef.current = null;
  }, []);

  const stopEverything = useCallback(() => {
    clearTimers();
    try {
      compRef.current?.stop();
    } catch {
      /* تجاهل */
    }
    compRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (stageRef.current) stageRef.current.innerHTML = '';
  }, [clearTimers]);

  const clearVideo = useCallback(() => {
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
    setVideoUrl(null);
    setVideoBlob(null);
  }, []);

  /* ---------------------- قراءة إعدادات الخادم أولًا ---------------------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      let cfg: { needsCode?: boolean; ready?: boolean } = {};
      try {
        const res = await fetch('/api/config', { cache: 'no-store' });
        cfg = (await res.json()) as typeof cfg;
      } catch {
        cfg = {};
      }
      if (!alive) return;

      setServerReady(cfg.ready !== false);

      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem('v10_code');
      } catch {
        saved = null;
      }

      if (!cfg.needsCode) {
        setPhase('idle');
        return;
      }

      if (saved) {
        const ok = await fetch('/api/verify-code', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: saved }),
        })
          .then((r) => r.ok)
          .catch(() => false);
        if (!alive) return;
        if (ok) {
          setCode(saved);
          setPhase('idle');
          return;
        }
      }
      setPhase('code');
    })();

    return () => {
      alive = false;
    };
  }, []);

  /* --------------------------- تنظيف عند الإغلاق --------------------------- */
  useEffect(() => {
    return () => {
      try {
        compRef.current?.stop();
      } catch {
        /* تجاهل */
      }
      clearTimers();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    };
  }, [clearTimers]);

  /* ----------------------------- إيقاف التسجيل ----------------------------- */
  const stopRecording = useCallback(() => {
    clearTimers();
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, [clearTimers]);

  /* ------------------------------ بدء التسجيل ------------------------------ */
  const startRecording = useCallback(async () => {
    setError(null);
    setElapsed(0);
    setRemaining(MAX_SECONDS);
    clearVideo();

    const mime = pickMimeType();
    if (mime === null) {
      setError('متصفحك لا يدعم تسجيل الفيديو. استخدم Chrome أو Safari أو Firefox حديثًا.');
      return;
    }
    mimeRef.current = mime;

    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
    } catch (err) {
      setError(friendlyError(err));
      return;
    }

    streamRef.current = stream;
    // تركيب: كاميرا + فيديو المونتاج فوقها (720×1280)
    let comp: Composition;
    try {
      comp = await startComposition({ cameraStream: stream, fxUrls: fxVideoUrls });
    } catch {
      setError('تعذّر تجهيز طبقة الكاميرا على هذا الجهاز.');
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      return;
    }
    compRef.current = comp;
    setCameraSize(comp.cameraSize);

    // نعرض الكانفس الناتج داخل الإطار
    if (stageRef.current) {
      stageRef.current.innerHTML = '';
      comp.canvas.className = 'stageCanvas';
      stageRef.current.appendChild(comp.canvas);
    }

    const options: MediaRecorderOptions = {
      videoBitsPerSecond: 2_800_000,
      audioBitsPerSecond: 96_000,
    };
    if (mime) options.mimeType = mime;

    let recorder: MediaRecorder | null = null;
    try {
      recorder = new MediaRecorder(comp.stream, options);
    } catch {
      try {
        recorder = new MediaRecorder(comp.stream, {
          videoBitsPerSecond: 2_800_000,
          audioBitsPerSecond: 96_000,
        });
      } catch {
        recorder = null;
      }
    }

    if (!recorder) {
      setError('تعذّر بدء التسجيل في هذا المتصفح.');
      stopEverything();
      setPhase('idle');
      return;
    }

    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onerror = () => {
      stopEverything();
      setError('حدث خطأ أثناء التسجيل، أعد المحاولة.');
      setPhase('idle');
    };

    recorder.onstop = () => {
      clearTimers();

      const actualMime = recorder?.mimeType || mimeRef.current || 'video/webm';
      const blob = new Blob(chunksRef.current, { type: actualMime });
      chunksRef.current = [];

      const duration = Math.min(MAX_SECONDS, (performance.now() - startAtRef.current) / 1000);

      try {
        comp.stop();
      } catch {
        /* تجاهل */
      }
      compRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (stageRef.current) stageRef.current.innerHTML = '';

      if (blob.size === 0) {
        setError('لم يُسجَّل أي شيء، جرّب مرة أخرى.');
        setPhase('idle');
        return;
      }

      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      const url = URL.createObjectURL(blob);
      videoUrlRef.current = url;

      setVideoBlob(blob);
      setVideoUrl(url);
      setElapsed(duration);
      setPhase('preview');
    };

    startAtRef.current = performance.now();
    setPhase('recording');
    setRemaining(MAX_SECONDS);
    setElapsed(0);

    timerRef.current = setInterval(() => {
      const secs = (performance.now() - startAtRef.current) / 1000;
      setElapsed(secs);
      setRemaining(Math.max(0, MAX_SECONDS - secs));
    }, 100);

    // ⏱️ الإيقاف التلقائي عند 5 ثوانٍ
    timeoutRef.current = setTimeout(stopRecording, MAX_SECONDS * 1000);

    try {
      recorder.start(250);
    } catch {
      stopEverything();
      setError('تعذّر بدء التسجيل في هذا المتصفح.');
      setPhase('idle');
    }
  }, [clearTimers, clearVideo, fxVideoUrls, stopEverything, stopRecording]);

  /* --------------------- البدء التلقائي بعد فتح الرابط --------------------- */
  // نحفظ أحدث نسخة من startRecording في مرجع حتى لا يعتمد المؤقت على هوية الدالة
  const startRecordingRef = useRef(startRecording);
  useEffect(() => {
    startRecordingRef.current = startRecording;
  }, [startRecording]);

  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    if (phase !== 'idle' || serverReady === false) return;

    autoStartedRef.current = true;
    // لا نُلغي المؤقت في دالة التنظيف: تغيّر أي حالة خلال المهلة كان يمنع البدء
    setTimeout(() => {
      void startRecordingRef.current();
    }, 150);
  }, [autoStart, phase, serverReady]);

  /* ------------------------------ إعادة الضبط ------------------------------ */
  const resetToIdle = useCallback(() => {
    clearVideo();
    setElapsed(0);
    setRemaining(MAX_SECONDS);
    setError(null);
    setPhase('idle');
    autoStartedRef.current = true; // لا نعيد البدء التلقائي عند التسجيل مجددًا
  }, [clearVideo]);

  /* -------------------------------- الإرسال -------------------------------- */
  const sendVideo = useCallback(async () => {
    if (!videoBlob || sending) return;
    setSending(true);
    setError(null);

    try {
      const isMp4 = (videoBlob.type || '').includes('mp4');
      const form = new FormData();
      form.append('video', videoBlob, `video.${isMp4 ? 'mp4' : 'webm'}`);
      form.append('duration', String(elapsed.toFixed(2)));
      form.append(
        'meta',
        JSON.stringify({
          duration: Number(elapsed.toFixed(2)),
          width: 720,
          height: 1280,
          mime: videoBlob.type,
        })
      );

      const res = await fetch('/api/send', {
        method: 'POST',
        body: form,
        headers: code ? { 'x-access-code': code } : undefined,
      });

      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; messageId?: number | null }
        | null;

      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `فشل الإرسال (HTTP ${res.status})`);
      }

      setPhase('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل الإرسال، حاول مجددًا.');
      setPhase('preview');
    } finally {
      setSending(false);
    }
  }, [code, elapsed, sending, videoBlob]);

  /* ------------------------------ رمز الدخول ------------------------------ */
  const submitCode = useCallback(async () => {
    setCodeError(null);
    try {
      const res = await fetch('/api/verify-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        setCodeError('رمز الدخول غير صحيح.');
        return;
      }
      try {
        sessionStorage.setItem('v10_code', code);
      } catch {
        /* تجاهل */
      }
      setPhase('idle');
    } catch {
      setCodeError('تعذّر التحقق الآن، حاول مجددًا.');
    }
  }, [code]);

  /* -------------------------------- الواجهة -------------------------------- */
  const progress = Math.min(1, elapsed / MAX_SECONDS);
  const secondsLeft = Math.max(0, Math.ceil(remaining));
  const showPreview = phase === 'preview' || phase === 'sending' || phase === 'sent';
  const showStage = phase === 'recording' || (phase === 'idle' && false);

  return (
    <main className="app">
      <div className="shell">
        <header className="head">
          <div className="brand">
            <span className="dot" aria-hidden="true" />
            <h1>عشر ثوانٍ</h1>
          </div>
          <p className="sub">الكاميرا الأمامية • مونتاج مباشر • إرسال إلى تلغرام</p>
        </header>

        {serverReady === false && (
          <div className="banner warn">
            ⚠️ الخادم غير مهيأ: أضف <code>TELEGRAM_BOT_TOKEN</code> و <code>TELEGRAM_CHAT_ID</code> في
            متغيرات البيئة على Vercel ثم أعد النشر.
          </div>
        )}

        <div className="stage">
          <div className={`camera ${phase === 'recording' ? 'is-rec' : ''}`}>
            {/* الكانفس الناتج عن التركيب */}
            <div
              ref={stageRef}
              className="stageHost"
              style={{ display: showPreview ? 'none' : 'block' }}
            />

            {/* معاينة التسجيل */}
            {showPreview && videoUrl && (
              <video className="viewer" src={videoUrl} controls playsInline autoPlay loop />
            )}

            {phase === 'loading' && <div className="hint">جارٍ التجهيز…</div>}

            {phase === 'idle' && (
              <div className="hint">
                <span>ستُشغَّل الكاميرا عند الضغط على «ابدأ التسجيل»</span>
              </div>
            )}

            {phase === 'recording' && (
              <>
                <div className="recBadge">
                  <span className="recDot" /> REC
                </div>
                <div className="countRing" aria-live="polite">
                  {secondsLeft}
                </div>
                <div className="progressWrap">
                  <div className="progressBar" style={{ width: `${progress * 100}%` }} />
                </div>
                {!showStage && null}
              </>
            )}

            {phase === 'sending' && (
              <div className="overlay">
                <span className="spinner" /> جارٍ الإرسال إلى تلغرام…
              </div>
            )}

            {phase === 'sent' && (
              <div className="overlay ok">
                <span>✅ تم الإرسال بنجاح</span>
                <span className="meta">تحقق من محادثة البوت في تلغرام</span>
              </div>
            )}
          </div>

          {error && <div className="banner err">{error}</div>}

          {phase === 'sent' ? (
            <div className="actions">
              <button className="btn primary" onClick={resetToIdle}>
                🔄 تسجيل فيديو جديد
              </button>
            </div>
          ) : phase === 'preview' || phase === 'sending' ? (
            <>
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={!videoBlob || sending}
                  onClick={sendVideo}
                  aria-busy={sending}
                >
                  {sending ? 'جارٍ الإرسال…' : '📤 إرسال إلى تلغرام'}
                </button>
                <button className="btn ghost" disabled={sending} onClick={resetToIdle}>
                  🎬 إعادة التسجيل
                </button>
              </div>
              <div className="note">
                المدة المسجّلة: {elapsed.toFixed(1)} ثانية
                {cameraSize ? ` • الكاميرا ${cameraSize.width}×${cameraSize.height}` : ''}
              </div>
            </>
          ) : (
            <div className="actions">
              {phase === 'recording' ? (
                <button className="btn danger solid" onClick={stopRecording}>
                  ⏹ إيقاف التسجيل الآن
                </button>
              ) : (
                <button
                  className="btn primary"
                  disabled={phase !== 'idle' || serverReady === false}
                  onClick={startRecording}
                >
                  ⏺ ابدأ التسجيل ({MAX_SECONDS} ثوانٍ)
                </button>
              )}
            </div>
          )}

          <p className="note foot">لا يُخزَّن الفيديو على الخادم — يمرّ مباشرةً إلى تلغرام.</p>
        </div>
      </div>

      {phase === 'code' && (
        <div className="modal">
          <div className="modalCard">
            <h2>رمز الدخول</h2>
            <p>هذه الصفحة محمية. أدخل الرمز للمتابعة.</p>
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCode();
              }}
              placeholder="••••••••"
            />
            {codeError && <div className="banner err small">{codeError}</div>}
            <button className="btn primary" onClick={submitCode} disabled={!code.trim()}>
              دخول
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
