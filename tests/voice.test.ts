import { describe, it, expect } from 'vitest';
import { api, auth, registered } from './helpers';

// هدر واقعی فایل‌ها کافی است؛ سرور نوع را از محتوا تشخیص می‌دهد
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 1)]);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(200, 2)]);

describe('voice messages in chat', () => {
  it('uploads a recording (WebM or iPhone M4A) as a voice message with duration and a signed url', async () => {
    const a = await registered('contractor');
    const b = await registered('worker');
    const c = await api().post('/api/conversations').set(auth(a.token)).send({ profileCode: b.profile.code });
    const cid = c.body.conversation.id;

    const v = await api().post(`/api/conversations/${cid}/attachments`).set(auth(a.token)).field('duration', '7').attach('file', WEBM, { filename: 'voice.webm', contentType: 'audio/webm' });
    expect(v.status).toBe(201);
    expect(v.body.message).toMatchObject({ kind: 'voice', payload: { mime: 'audio/webm', dur: 7, url: expect.any(String) } });

    const i = await api().post(`/api/conversations/${cid}/attachments`).set(auth(b.token)).field('duration', '3').attach('file', M4A, { filename: 'voice.m4a', contentType: 'audio/mp4' });
    expect(i.body.message).toMatchObject({ kind: 'voice', payload: { mime: 'audio/mp4', dur: 3 } });

    const list = await api().get(`/api/conversations/${cid}/messages`).set(auth(b.token));
    const got = list.body.items.filter((m: { kind: string }) => m.kind === 'voice');
    expect(got).toHaveLength(2);
    const file = await api().get(got[0].payload.url.replace(/^https?:\/\/[^/]+/, ''));
    expect(file.status).toBe(200);

    // صدا فقط در چت؛ مثلاً عکس پروفایل نمی‌شود
    const bad = await api().put(`/api/me/roles/worker/avatar`).set(auth(b.token)).attach('file', WEBM, { filename: 'x.webm', contentType: 'audio/webm' });
    expect(bad.body.error.code).toBe('FILE_TYPE');
  });
});
