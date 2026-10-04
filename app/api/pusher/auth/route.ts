import { createHash, createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const clientIdPattern = /^kc_[a-f0-9]{32}$/;
const publicIdPattern = /^pu_[a-f0-9]{32}$/;
const gameIdPattern = /^g_[a-f0-9]{32}$/;

export async function POST(request: NextRequest) {
  const key = process.env.PUSHER_APP_KEY;
  const secret = process.env.PUSHER_APP_SECRET;
  if (!key || !secret) return NextResponse.json({ error: 'Realtime is not configured.' }, { status: 503 });

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'Invalid channel authorization request.' }, { status: 400 });
  const socketId = String(form.get('socket_id') || '');
  const channelName = String(form.get('channel_name') || '');
  const clientId = String(form.get('client_id') || '');
  const publicId = String(form.get('public_id') || '');
  const displayName = String(form.get('display_name') || '').trim().slice(0, 32);

  if (!/^\d+\.\d+$/.test(socketId) || !clientIdPattern.test(clientId) || !publicIdPattern.test(publicId) || displayName.length < 1) {
    return NextResponse.json({ error: 'Invalid player identity.' }, { status: 400 });
  }
  const expectedPublicId = `pu_${createHash('sha256').update(clientId).digest('hex').slice(0, 32)}`;
  if (publicId !== expectedPublicId) return NextResponse.json({ error: 'Player identity does not match.' }, { status: 403 });

  const isPresence = channelName === 'presence-knightclub-v1';
  // Only the owner can listen on their inbox. The separate Vercel trigger route
  // sends authenticated, ephemeral events to that channel without exposing it to friends.
  const isPlayerInbox = channelName === `private-player-${clientId}`;
  const isGameChannel = /^private-game-g_[a-f0-9]{32}$/.test(channelName) && gameIdPattern.test(channelName.slice('private-game-'.length));
  if (!isPresence && !isPlayerInbox && !isGameChannel) {
    return NextResponse.json({ error: 'You cannot subscribe to this channel.' }, { status: 403 });
  }

  const channelData = isPresence ? JSON.stringify({ user_id: publicId, user_info: { display_name: displayName } }) : undefined;
  const stringToSign = isPresence ? `${socketId}:${channelName}:${channelData}` : `${socketId}:${channelName}`;
  const signature = createHmac('sha256', secret).update(stringToSign).digest('hex');
  return NextResponse.json({ auth: `${key}:${signature}`, ...(channelData ? { channel_data: channelData } : {}) });
}
