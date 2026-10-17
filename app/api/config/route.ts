import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    {
      needsCode: Boolean(process.env.ACCESS_CODE?.trim()),
      ready: Boolean(
        process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim()
      ),
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
