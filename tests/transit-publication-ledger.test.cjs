const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { loadBotAlertRoutes } = require("./helpers/bot-alert-routes.cjs");
const env = { DATABASE_URL: "postgresql://fake.invalid/not-used" };

function fixture(status) {
  const alert = { id: "producer_hash", timeStart: new Date(), timeEnd: null, headerText: "Test", descriptionText: "Fake alert",
    routeIds: "33", stopIds: null, cause: "OTHER_CAUSE", effect: "OTHER_EFFECT", isPosted: false, isProcessing: false, inProcessSince: null };
  const receipts = new Map(status ? [[alert.id, { alertId: alert.id, status }]] : []);
  const calls = [];
  const db = {
    alert: {
      findMany: async () => !alert.isPosted && !alert.isProcessing ? [alert] : [],
      updateMany: async ({ data }) => { calls.push(["alert", data]); Object.assign(alert, data); return { count: 1 }; },
    },
    publicationLedger: {
      findMany: async () => [...receipts.values()],
      count: async () => receipts.size,
      createMany: async ({ data }) => { for (const item of data) receipts.set(item.alertId, item); calls.push(["receipt", "UNCERTAIN"]); },
      upsert: async ({ where, create, update }) => { receipts.set(where.alertId, receipts.has(where.alertId) ? { ...receipts.get(where.alertId), ...update } : create); },
      deleteMany: async () => { for (const [id, value] of receipts) if (value.status === "UNCERTAIN") receipts.delete(id); },
    },
    $queryRaw: async () => [{ locked: true }],
    $executeRaw: async () => 0,
  };
  db.$transaction = async (callback) => callback(db);
  const ledger = loadTypeScript("lib/transit/publication-ledger.ts", { env });
  return { alert, receipts, calls, db, ledger };
}

for (const status of ["CONFIRMED", "UNCERTAIN"]) {
  test(`a purged then recreated alert remains protected by its independent ${status} receipt`, async () => {
    const { db, ledger, alert } = fixture(status);
    let sends = 0;
    const posting = loadTypeScript("app/api/post_tweets/postTweet.ts", { env,
      mocks: { "./alertRoutes": loadBotAlertRoutes(), "@/lib/prisma": { prisma: db }, "@/lib/transit/publication-ledger": ledger,
        "./publisher": { getPublisherConfiguration: () => ({ mode: "browser", configured: true }),
          createTextPublisher: () => ({ postText: async () => { sends++; throw new Error("must not send"); }, close: async () => {} }) } },
    });
    const result = await posting.postToTwitter();
    assert.equal(result.success, true);
    assert.equal(result.processed, 0);
    assert.equal(sends, 0);
    assert.equal(alert.isPosted, status === "CONFIRMED");
    assert.equal(alert.isProcessing, status === "UNCERTAIN");
    assert.equal(alert.inProcessSince, null);
  });
}

test("the durable uncertain receipt exists before a send and is confirmed with the public post ID", async () => {
  const { db, ledger, alert, receipts } = fixture();
  const claimedAt = new Date();
  alert.isProcessing = true;
  alert.inProcessSince = claimedAt;
  await ledger.preparePublicationGroup(db, [alert.id], claimedAt);
  assert.equal(receipts.get(alert.id).status, "UNCERTAIN");
  assert.equal(alert.inProcessSince, null);
  await ledger.confirmPublicationGroup(db, [alert.id], "123456789");
  assert.equal(receipts.get(alert.id).status, "CONFIRMED");
  assert.equal(receipts.get(alert.id).tweetId, "123456789");
  assert.equal(alert.isPosted, true);
});

test("explicit rejection releases its uncertain receipt, but cannot delete a confirmed publication", async () => {
  for (const status of ["UNCERTAIN", "CONFIRMED"]) {
    const { db, ledger, alert, receipts } = fixture(status);
    await ledger.releaseRejectedGroup(db, [alert.id]);
    assert.equal(receipts.has(alert.id), status === "CONFIRMED");
  }
});

test("a receipt appearing before preparation blocks the send instead of overwriting publication history", async () => {
  const { db, ledger, alert, calls } = fixture("CONFIRMED");
  await assert.rejects(ledger.preparePublicationGroup(db, [alert.id], new Date()), /déjà enregistrée/);
  assert.equal(calls.length, 0);
});
