import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { canonicalJson } from '@/lib/canonical-json';

const playerIdPattern = /^kc_[a-f0-9]{32}$/;
const publicIdPattern = /^pu_[a-f0-9]{32}$/;
const gameIdPattern = /^g_[a-f0-9]{32}$/;
const allowedEvents = new Set(['friend-request', 'friend-accepted', 'friend-declined', 'challenge', 'challenge-answer']);

function hasValidPayload(eventName: string, fromId: string, targetId: string, data: Record<string, unknown>) {
  if (eventName === 'friend-request') {
    const from = data.from as Record<string, unknown> | undefined;
    return typeof data.requestId === 'string' && data.requestId.length <= 80 && from?.id === fromId && publicIdPattern.test(String(from.public_id || ''));
  }
  if (eventName === 'friend-accepted') {
    const friend = data.friend as Record<string, unknown> | undefined;
    return friend?.id === fromId && publicIdPattern.test(String(friend.public_id || ''));
  }
  if (eventName === 'friend-declined') return data.fromId === fromId;
  if (eventName === 'challenge') {
    const from = data.from as Record<string, unknown> | undefined;
    const game = data.game as Record<string, unknown> | undefined;
    return from?.id === fromId && publicIdPattern.test(String(from.public_id || '')) && game?.white_id === fromId && game?.black_id === targetId && game?.status === 'pending' && gameIdPattern.test(String(game.id || ''));
  }
  if (eventName === 'challenge-answer') {
    return gameIdPattern.test(String(data.gameId || '')) && typeof data.accepted === 'boolean';
  }
  return false;
}

export async function POST(request: NextRequest) {
  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.PUSHER_APP_KEY;
  const secret = process.env.PUSHER_APP_SECRET;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
  if (!appId || !key || !secret || !cluster || !/^[a-z0-9-]+$/.test(cluster)) {
    return NextResponse.json({ error: 'Pusher server settings are incomplete.' }, { status: 503 });
  }

  const input = await request.json().catch(() => null);
  if (!input || typeof input !== 'object') return NextResponse.json({ error: 'Invalid event.' }, { status: 400 });
  const targetId = String(input.targetId || '');
  const fromId = String(input.fromId || '');
  const eventName = String(input.eventName || '');
  const issuedAt = Number(input.issuedAt);
  const signature = String(input.signature || '');
  const data = input.data;
  if (!playerIdPattern.test(targetId) || !playerIdPattern.test(fromId) || targetId === fromId || !allowedEvents.has(eventName) || !Number.isFinite(issuedAt) || !/^[a-f0-9]{64}$/.test(signature) || !data || typeof data !== 'object' || Array.isArray(data)) {
    return NextResponse.json({ error: 'Invalid player event.' }, { status: 400 });
  }
  if (Math.abs(Date.now() - issuedAt) > 120_000) return NextResponse.json({ error: 'Event signature expired.' }, { status: 401 });
  const dataSize = Buffer.byteLength(JSON.stringify(data), 'utf8');
  if (dataSize > 7_500 || !hasValidPayload(eventName, fromId, targetId, data as Record<string, unknown>)) {
    return NextResponse.json({ error: 'Event payload is not allowed.' }, { status: 400 });
  }

  const envelope = { targetId, eventName, fromId, issuedAt, data };
  const expected = createHmac('sha256', fromId).update(canonicalJson(envelope)).digest();
  const actual = Buffer.from(signature, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: 'Player capability signature is invalid.' }, { status: 401 });
  }

  const path = `/apps/${encodeURIComponent(appId)}/events`;
  const body = JSON.stringify({
    name: eventName,
    channels: [`private-player-${targetId}`],
    data: JSON.stringify(data),
  });
  const bodyMd5 = createHash('md5').update(body).digest('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const authQuery = `auth_key=${encodeURIComponent(key)}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
  const authSignature = createHmac('sha256', secret).update(`POST\n${path}\n${authQuery}`).digest('hex');
  const url = `https://api-${cluster}.pusher.com${path}?${authQuery}&auth_signature=${authSignature}`;

  try {
    const relayResponse = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      cache: 'no-store', signal: AbortSignal.timeout(8_000),
    });
    if (!relayResponse.ok) return NextResponse.json({ error: 'Realtime relay rejected the event.' }, { status: 502 });
    return NextResponse.json({ ok: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Realtime relay is unavailable.' }, { status: 502 });
  }
}
