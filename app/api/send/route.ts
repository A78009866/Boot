import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const runtime = 'nodejs';
// نحتاج وقتًا كافيًا لرفع الفيديو إلى تلغرام (وبديل ffmpeg إن لزم)
export const maxDuration = 60;

const MAX_BYTES = 45 * 1024 * 1024; // حد تيليجرام للإرسال عبر البوت 50MB — نترك هامشًا
const MAX_SECONDS = 60;

type TelegramOk = { ok: true; result: { message_id?: number } };
type TelegramErr = { ok: false; error_code?: number; description?: string };

function fail(status: number, error: string) {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { 'cache-control': 'no-store' } }
  );
}

function normalizeMime(type: string): 'video/mp4' | 'video/webm' {
  const t = (type || '').toLowerCase();
  if (t.includes('webm')) return 'video/webm';
  return 'video/mp4';
}

/** يحاول تحويل WebM إلى MP4 عبر ffmpeg إن كان متوفرًا (خطة بديلة فقط) */
async function tryConvertToMp4(input: Buffer): Promise<Buffer> {
  let ffmpegPath: string | null = null;

  try {
    // الحزمة اختيارية (optionalDependencies) — قد لا تكون مثبتة
    const mod = (await import('ffmpeg-static')) as unknown as { default?: string } | string;
    ffmpegPath = typeof mod === 'string' ? mod : (mod?.default ?? null);
  } catch {
    ffmpegPath = null;
  }

  if (!ffmpegPath && process.env.FFMPEG_PATH) ffmpegPath = process.env.FFMPEG_PATH;
  if (!ffmpegPath) ffmpegPath = 'ffmpeg';

  const dir = await mkdtemp(path.join(tmpdir(), 'v10-'));
  try {
    const inFile = path.join(dir, 'input.webm');
    const outFile = path.join(dir, 'output.mp4');
    await writeFile(inFile, input);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath as string, [
        '-y',
        '-i', inFile,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '26',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outFile,
      ]);

      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < 4000) stderr += d.toString();
      });
      proc.on('error', reject);
      proc.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-400)}`))
      );
    });

    return await readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildCaption(meta: Record<string, unknown>): string {
  const now = new Date();
  let stamp: string;
  try {
    stamp = new Intl.DateTimeFormat('ar', {
      timeZone: process.env.CAPTION_TIMEZONE || 'Africa/Algiers',
      dateStyle: 'medium',
      timeStyle: 'short',
      numberingSystem: 'latn',
      calendar: 'gregory',
    }).format(now);
  } catch {
    stamp = now.toISOString().replace('T', ' ').slice(0, 16);
  }

  const lines: string[] = [`🎥 <b>فيديو جديد</b> — ${stamp}`];

  if (typeof meta.duration === 'number' && Number.isFinite(meta.duration) && meta.duration > 0) {
    lines.push(`⏱️ المدة: ${(Math.round(meta.duration * 10) / 10).toFixed(1)} ثانية`);
  }
  if (
    typeof meta.width === 'number' &&
    typeof meta.height === 'number' &&
    meta.width > 0 &&
    meta.height > 0
  ) {
    lines.push(`📐 الدقة: ${Math.round(meta.width)}×${Math.round(meta.height)}`);
  }
  if (typeof meta.size === 'number' && meta.size > 0) {
    lines.push(`📦 الحجم: ${(meta.size / (1024 * 1024)).toFixed(2)} MB`);
  }

  return lines.join('\n');
}

export async function POST(req: NextRequest) {
  /* ---------- 1) التحقق من إعدادات الخادم ---------- */
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    return fail(500, 'لم تتم تهيئة الخادم: أضف TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID في متغيرات البيئة.');
  }

  /* ---------- 2) رمز الدخول (اختياري) ---------- */
  const accessCode = process.env.ACCESS_CODE?.trim();
  if (accessCode && req.headers.get('x-access-code') !== accessCode) {
    return fail(401, 'رمز الدخول غير صحيح.');
  }

  /* ---------- 3) قراءة الفيديو ---------- */
  const declaredLength = Number(req.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BYTES + 1024 * 1024) {
    return fail(413, 'حجم الفيديو أكبر من المسموح (45MB).');
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, 'تعذّر قراءة الطلب.');
  }

  const filePart = form.get('video');
  if (!(filePart instanceof Blob)) {
    return fail(400, 'لم يصل أي فيديو في الطلب.');
  }
  if (filePart.size === 0) {
    return fail(400, 'الملف فارغ، جرّب التسجيل مرة أخرى.');
  }
  if (filePart.size > MAX_BYTES) {
    return fail(413, 'حجم الفيديو أكبر من المسموح (45MB).');
  }

  const declaredDuration = Number(form.get('duration') ?? 0);
  if (Number.isFinite(declaredDuration) && declaredDuration > MAX_SECONDS) {
    return fail(400, 'مدة الفيديو أطول من المسموح.');
  }

  let meta: Record<string, unknown> = {};
  try {
    const raw = form.get('meta');
    if (typeof raw === 'string' && raw.length < 2000) {
      meta = JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    meta = {};
  }

  const inputMime = normalizeMime(filePart.type);
  let bytes: Buffer = Buffer.from(await filePart.arrayBuffer());
  let finalMime: 'video/mp4' | 'video/webm' = inputMime;

  // إن سجّل المتصفح WebM نحاول إنتاج MP4 حقيقي عبر ffmpeg، وإلا نرسله كما هو.
  if (inputMime === 'video/webm') {
    try {
      bytes = await tryConvertToMp4(bytes);
      finalMime = 'video/mp4';
    } catch {
      finalMime = 'video/webm';
    }
  }

  const ext = finalMime === 'video/mp4' ? 'mp4' : 'webm';
  const filename = `video-${Date.now()}.${ext}`;
  const caption = buildCaption({ ...meta, size: bytes.byteLength });

  /* ---------- 4) الإرسال إلى تلغرام ---------- */
  const callTelegram = async (method: 'sendVideo' | 'sendDocument') => {
    const fd = new FormData();
    const blob = new Blob([new Uint8Array(bytes)], { type: finalMime });

    fd.append(method === 'sendVideo' ? 'video' : 'document', blob, filename);
    fd.append('chat_id', chatId);
    fd.append('caption', caption);
    fd.append('parse_mode', 'HTML');
    if (method === 'sendVideo') fd.append('supports_streaming', 'true');

    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(45_000),
    });

    const data = (await res.json().catch(() => null)) as TelegramOk | TelegramErr | null;
    if (!res.ok || !data || data.ok !== true) {
      const description =
        data && 'description' in data && data.description ? data.description : `HTTP ${res.status}`;
      throw new Error(description);
    }
    return data as TelegramOk;
  };

  try {
    let result: TelegramOk;
    try {
      result = await callTelegram('sendVideo');
    } catch (videoErr) {
      // بعض ملفات MP4 الناتجة عن المتصفح قد لا يعتبرها تيليجرام «فيديو» صالحًا،
      // لذا نجرب إرسالها كملف عادي قبل الاستسلام.
      try {
        result = await callTelegram('sendDocument');
      } catch {
        throw videoErr;
      }
    }

    return NextResponse.json(
      { ok: true, messageId: result.result?.message_id ?? null },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'خطأ غير معروف';
    return fail(502, `تعذّر الإرسال إلى تلغرام: ${message}`);
  }
}
