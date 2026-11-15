import { DurableObject } from 'cloudflare:workers';
import { audit, setOnline } from './db';

const MAX_FRAME = 16 * 1024;

// Per-socket state kept across hibernation. `replaced` marks a socket we closed ourselves for a newer one.
type Att = { peerId: string; peerHash: string; roomHash: string; replaced?: boolean };

export class Room extends DurableObject<Env> {
	// Headers set by index.ts (clients cannot reach this DO directly): x-peer-id, x-peer-hash, x-room-hash, x-max-peers.
	async fetch(request: Request): Promise<Response> {
		const h = request.headers;
		const att: Att = { peerId: h.get('x-peer-id')!, peerHash: h.get('x-peer-hash')!, roomHash: h.get('x-room-hash')! };
		const others = this.live().filter((s) => s.deserializeAttachment().peerId !== att.peerId);
		if (others.length >= Number(h.get('x-max-peers'))) return Response.json({ error: 'room_full' }, { status: 429 });

		for (const s of this.live()) {
			if (s.deserializeAttachment().peerId !== att.peerId) continue;
			s.serializeAttachment({ ...s.deserializeAttachment(), replaced: true });
			s.close(4000, 'replaced');
		}

		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(att);
		server.send(JSON.stringify({ t: 'peers', peers: others.map((s) => s.deserializeAttachment().peerId) }));
		this.broadcast(server, { t: 'join', peer: att.peerId });
		await setOnline(this.env, att.peerHash, true);
		await audit(this.env, 'join', att.roomHash, att.peerHash);
		return new Response(null, { status: 101, webSocket: client });
	}

	// Called by the admin API (RPC): closes the peer's live socket; webSocketClose does the usual leave bookkeeping.
	async kick(peerHash: string): Promise<void> {
		for (const s of this.live()) if (s.deserializeAttachment().peerHash === peerHash) s.close(4003, 'revoked');
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (typeof message !== 'string') return;
		if (new TextEncoder().encode(message).length > MAX_FRAME) return ws.close(1009, 'too big');
		let msg: { to?: unknown; data?: unknown };
		try {
			msg = JSON.parse(message);
		} catch {
			return;
		}
		if (typeof msg?.to !== 'string' || typeof msg.data !== 'string') return;
		const from: Att = ws.deserializeAttachment();
		const target = this.live().find((s) => s.deserializeAttachment().peerId === msg.to);
		target?.send(JSON.stringify({ t: 'signal', from: from.peerId, data: msg.data }));
	}

	async webSocketClose(ws: WebSocket) {
		const a: Att = ws.deserializeAttachment();
		if (a.replaced) return;
		ws.serializeAttachment({ ...a, replaced: true }); // makes a second close/error event a no-op
		this.broadcast(ws, { t: 'leave', peer: a.peerId });
		await setOnline(this.env, a.peerHash, false);
		await audit(this.env, 'leave', a.roomHash, a.peerHash);
	}

	async webSocketError(ws: WebSocket) {
		await this.webSocketClose(ws);
	}

	private live() {
		return this.ctx.getWebSockets().filter((s) => !s.deserializeAttachment()?.replaced);
	}

	private broadcast(except: WebSocket, msg: object) {
		const text = JSON.stringify(msg);
		for (const s of this.live()) if (s !== except) s.send(text);
	}
}
