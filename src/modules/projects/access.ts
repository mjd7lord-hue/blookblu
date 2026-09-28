import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../db';
import { conversations, profiles, projects } from '../../db/schema';
import { conflict, notFound } from '../../lib/errors';
import { postMessage } from '../chat/chat.service';

export type Project = typeof projects.$inferSelect;
export const clientP = alias(profiles, 'client_p');
export const providerP = alias(profiles, 'provider_p');

export const party = (p: typeof clientP | typeof providerP) => ({
  id: p.id,
  code: p.code,
  name: p.displayName,
  role: p.role,
  userId: p.userId,
  verified: p.verified,
  avatarFileId: p.avatarFileId,
});
export type Party = { id: string; code: string; name: string; role: string; userId: string; verified: boolean; avatarFileId: string | null };

/** پروژه + دو طرف؛ برای غیرِ طرفین «پیدا نشد» */
export async function load(userId: string, id: string) {
  const [row] = await db
    .select({ p: projects, client: party(clientP), provider: party(providerP) })
    .from(projects)
    .innerJoin(clientP, eq(clientP.id, projects.clientProfileId))
    .innerJoin(providerP, eq(providerP.id, projects.providerProfileId))
    .where(eq(projects.id, id))
    .limit(1);
  if (!row || (row.client.userId !== userId && row.provider.userId !== userId)) throw notFound('پروژه پیدا نشد');
  return row;
}

/** پروژه از دید کاربر: من کدام طرفم و طرف مقابل کیست */
export async function projectFor(userId: string, id: string) {
  const row = await load(userId, id);
  const side = row.client.userId === userId ? ('client' as const) : ('provider' as const);
  return { ...row, side, me: side === 'client' ? row.client : row.provider, other: side === 'client' ? row.provider : row.client };
}

export function assertActive(p: Project) {
  if (p.status !== 'active') throw conflict(p.status === 'done' ? 'این پروژه تمام شده است' : 'این پروژه لغو شده است', 'PROJECT_CLOSED');
}

/** پیام سیستمی در گفت‌وگوی پروژه (اگر هست) */
export async function projectSysMessage(p: Project, body: string) {
  if (!p.conversationId) return;
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, p.conversationId)).limit(1);
  if (conv) await postMessage(conv, null, { kind: 'sys', body, projectId: p.id });
}
