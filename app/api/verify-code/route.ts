import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const accessCode = process.env.ACCESS_CODE?.trim();
  // إذا لم يُضبط رمز دخول في متغيرات البيئة فالصفحة مفتوحة ولا حاجة للتحقق.
  if (!accessCode) {
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const code =
    typeof body === 'object' && body !== null && 'code' in body
      ? String((body as { code?: unknown }).code ?? '').trim()
      : '';

  const ok = code === accessCode;
  return NextResponse.json(
    { ok },
    { status: ok ? 200 : 401, headers: { 'cache-control': 'no-store' } }
  );
}
