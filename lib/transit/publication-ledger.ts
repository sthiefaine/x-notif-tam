import type { Alert, Prisma, PrismaClient } from "@prisma/client";

const enabled = () => Boolean(process.env.DATABASE_URL) && process.env.TRANSIT_PUBLICATION_LEDGER !== "false";

export async function restorePublicationStates(tx: Prisma.TransactionClient, alerts: Alert[]): Promise<Alert[]> {
  if (!enabled() || alerts.length === 0) return alerts;
  const receipts = await tx.publicationLedger.findMany({ where: { alertId: { in: alerts.map((alert) => alert.id) } } });
  const confirmed = receipts.filter((receipt) => receipt.status === "CONFIRMED").map((receipt) => receipt.alertId);
  const uncertain = receipts.filter((receipt) => receipt.status !== "CONFIRMED").map((receipt) => receipt.alertId);
  if (confirmed.length) await tx.alert.updateMany({ where: { id: { in: confirmed } }, data: { isPosted: true, isProcessing: false, inProcessSince: null } });
  if (uncertain.length) await tx.alert.updateMany({ where: { id: { in: uncertain }, isPosted: false }, data: { isProcessing: true, inProcessSince: null } });
  const protectedIds = new Set(receipts.map((receipt) => receipt.alertId));
  return alerts.filter((alert) => !protectedIds.has(alert.id));
}

export async function preparePublicationGroup(db: PrismaClient, ids: string[], claimedAt: Date) {
  const update = { where: { id: { in: ids }, isPosted: false, isProcessing: true, inProcessSince: claimedAt }, data: { inProcessSince: null } };
  if (!enabled()) return db.alert.updateMany(update);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(727043, 21)`;
    if (await tx.publicationLedger.count({ where: { alertId: { in: ids } } })) throw new Error("Publication déjà enregistrée");
    const result = await tx.alert.updateMany(update);
    if (result.count !== ids.length) throw new Error("Le lot a changé avant la publication");
    await tx.publicationLedger.createMany({ data: ids.map((alertId) => ({ alertId, status: "UNCERTAIN" })) });
    return result;
  });
}

export async function confirmPublicationGroup(db: PrismaClient, ids: string[], tweetId: string) {
  const update = { where: { id: { in: ids } }, data: { isPosted: true, isProcessing: false, inProcessSince: null } };
  if (!enabled()) return db.alert.updateMany(update);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(727043, 21)`;
    const result = await tx.alert.updateMany(update);
    for (const alertId of ids) await tx.publicationLedger.upsert({ where: { alertId },
      create: { alertId, status: "CONFIRMED", tweetId }, update: { status: "CONFIRMED", tweetId, recordedAt: new Date() } });
    return result;
  });
}

export async function releaseRejectedGroup(db: PrismaClient, ids: string[]) {
  const update = { where: { id: { in: ids }, isPosted: false }, data: { isProcessing: false, inProcessSince: null } };
  if (!enabled()) return db.alert.updateMany(update);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(727043, 21)`;
    const result = await tx.alert.updateMany(update);
    await tx.publicationLedger.deleteMany({ where: { alertId: { in: ids }, status: "UNCERTAIN" } });
    return result;
  });
}
