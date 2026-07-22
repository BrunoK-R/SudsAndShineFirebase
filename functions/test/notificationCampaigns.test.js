const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON,
  NOTIFICATION_CAMPAIGN_SEND_STATE,
  assertNotificationCampaignBroadcastReady,
  buildAdminNotificationCampaignDrafts,
  buildNotificationCampaignBroadcastReceipt,
  buildNotificationCampaignBroadcastUpdateValue,
  buildNotificationCampaignDraftArchiveValue,
  buildNotificationCampaignDraftMutationReceipt,
  buildNotificationCampaignDraftValue,
  normalizeNotificationCampaignDraft,
  validateNotificationCampaignBroadcastInput,
  validateNotificationCampaignDraftArchiveInput,
  validateNotificationCampaignDraftInput,
} = require("../notificationCampaigns");

const NOW = new Date("2026-06-01T09:00:00.000Z");

test("validateNotificationCampaignDraftInput builds safe broadcast-ready campaign documents", () => {
  const draft = validateNotificationCampaignDraftInput(
    {
      campaignId: "summer-offer",
      title: "  Oferta   de verão  ",
      body: "  Lavagem   premium   com desconto  ",
      targetAudience: "marketing_opt_in_users",
      scheduledAtIso: "2026-06-02T09:00:00.000Z",
      notes: "  Confirmar   copy antes do envio  ",
      marketingConsentRequired: false,
    },
    "fallback-id",
    NOW,
  );

  assert.equal(draft.campaignId, "summer-offer");
  assert.equal(draft.title, "Oferta de verão");
  assert.equal(draft.body, "Lavagem premium com desconto");
  assert.equal(draft.targetAudience, "marketing_opt_in_users");
  assert.deepEqual(draft.channels, ["push"]);
  assert.equal(draft.marketingConsentRequired, true);
  assert.equal(draft.status, "draft");
  assert.equal(draft.scheduledAtIso, "2026-06-02T09:00:00.000Z");
  assert.equal(draft.notes, "Confirmar copy antes do envio");
  assert.equal(draft.sendBlocked, false);
  assert.equal(draft.sendBlockedReason, "");

  assert.deepEqual(buildNotificationCampaignDraftValue(draft), {
    campaignId: "summer-offer",
    title: "Oferta de verão",
    body: "Lavagem premium com desconto",
    targetAudience: "marketing_opt_in_users",
    audienceType: "marketing_opt_in_users",
    channels: ["push"],
    marketingConsentRequired: true,
    status: "draft",
    scheduledAtIso: "2026-06-02T09:00:00.000Z",
    scheduledAt: draft.scheduledAt,
    notes: "Confirmar copy antes do envio",
    sendBlocked: false,
    sendBlockedReason: "",
    deliveryLocked: false,
    sendState: "ready",
    updateSource: "admin-mobile-notification-campaigns",
  });
});

test("validateNotificationCampaignDraftInput safely migrates the legacy all-users audience", () => {
  const draft = validateNotificationCampaignDraftInput(
    {
      title: "Teste",
      body: "Mensagem para equipa",
      targetAudience: "all_users",
    },
    "generated-safe-id",
    NOW,
  );

  assert.equal(draft.campaignId, "generated-safe-id");
  assert.equal(draft.targetAudience, "marketing_opt_in_users");
  assert.equal(draft.marketingConsentRequired, true);
  assert.equal(draft.scheduledAtIso, "");
  assert.equal(draft.scheduledAt, null);
});

test("validateNotificationCampaignDraftInput rejects unsafe targets and ids", () => {
  assert.throws(
    () => validateNotificationCampaignDraftInput({
      campaignId: "campaigns/summer",
      title: "Oferta",
      body: "Mensagem",
      targetAudience: "test_users",
    }, "fallback-id", NOW),
    /campaignId is invalid/,
  );

  assert.throws(
    () => validateNotificationCampaignDraftInput({
      title: "Oferta",
      body: "Mensagem",
      targetAudience: "all_customers",
    }, "fallback-id", NOW),
    /targetAudience/,
  );

  assert.throws(
    () => validateNotificationCampaignDraftInput({
      title: "Oferta",
      body: "Mensagem",
      targetAudience: "raw_token:fcm-token",
    }, "fallback-id", NOW),
    /targetAudience/,
  );
});

test("validateNotificationCampaignDraftInput rejects invalid schedules and copy", () => {
  assert.throws(
    () => validateNotificationCampaignDraftInput({
      title: "Oferta",
      body: "Mensagem",
      targetAudience: "test_users",
      channels: {email: true},
    }, "fallback-id", NOW),
    /Only push/,
  );

  assert.throws(
    () => validateNotificationCampaignDraftInput({
      title: "Oferta",
      body: "Mensagem",
      targetAudience: "test_users",
      channels: ["sms"],
    }, "fallback-id", NOW),
    /Only push/,
  );

  assert.throws(
    () => validateNotificationCampaignDraftInput({
      title: "Oferta",
      body: "Mensagem",
      targetAudience: "test_users",
      channel: "email",
    }, "fallback-id", NOW),
    /Only push/,
  );

  assert.throws(
    () => validateNotificationCampaignDraftInput({
      title: "Oferta",
      body: "Mensagem",
      targetAudience: "test_users",
      scheduledAtIso: "2026-06-01T09:03:00.000Z",
    }, "fallback-id", NOW),
    /5 minutes/,
  );

  assert.throws(
    () => validateNotificationCampaignDraftInput({
      title: "Oferta",
      body: "Mensagem",
      targetAudience: "test_users",
      scheduledAtIso: "not-a-date",
    }, "fallback-id", NOW),
    /valid ISO date/,
  );

  assert.throws(
    () => validateNotificationCampaignDraftInput({
      title: "",
      body: "Mensagem",
      targetAudience: "test_users",
    }, "fallback-id", NOW),
    /title is required/,
  );
});

test("validateNotificationCampaignDraftArchiveInput rejects path-like ids", () => {
  assert.deepEqual(
    validateNotificationCampaignDraftArchiveInput({campaignId: "spring-draft"}),
    {campaignId: "spring-draft"},
  );

  assert.throws(
    () => validateNotificationCampaignDraftArchiveInput({campaignId: "../spring-draft"}),
    /campaignId is invalid/,
  );
});

test("validateNotificationCampaignBroadcastInput requires explicit confirmation", () => {
  assert.deepEqual(
    validateNotificationCampaignBroadcastInput({campaignId: "summer-draft", confirmBroadcast: true}),
    {campaignId: "summer-draft", confirmBroadcast: true},
  );

  assert.throws(
    () => validateNotificationCampaignBroadcastInput({campaignId: "summer-draft"}),
    /explicit confirmation/,
  );
  assert.throws(
    () => validateNotificationCampaignBroadcastInput({campaignId: "../summer-draft", confirmBroadcast: true}),
    /campaignId is invalid/,
  );
});

test("assertNotificationCampaignBroadcastReady enforces draft state and schedule", () => {
  const campaign = {
    campaignId: "summer-draft",
    status: "draft",
    targetAudience: "marketing_opt_in_users",
    scheduledAtIso: "2026-06-01T10:00:00.000Z",
  };

  assert.equal(
    assertNotificationCampaignBroadcastReady(campaign, new Date("2026-06-01T10:00:00.000Z")),
    campaign,
  );
  assert.throws(
    () => assertNotificationCampaignBroadcastReady(campaign, new Date("2026-06-01T09:59:59.000Z")),
    /scheduled time has not been reached/,
  );
  assert.throws(
    () => assertNotificationCampaignBroadcastReady({...campaign, status: "sent"}, NOW),
    /Only active draft/,
  );
  assert.throws(
    () => assertNotificationCampaignBroadcastReady(
      {...campaign, targetAudience: "all_users"},
      new Date(campaign.scheduledAtIso),
    ),
    /audience is not safe/,
  );
});

test("buildNotificationCampaignDraftArchiveValue keeps archived campaigns send locked", () => {
  assert.deepEqual(buildNotificationCampaignDraftArchiveValue(), {
    status: "archived",
    sendBlocked: true,
    sendBlockedReason: NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON,
    deliveryLocked: true,
    sendState: "archived",
    updateSource: "admin-mobile-notification-campaigns",
  });
});

test("buildNotificationCampaignDraftMutationReceipt reports ready send state", () => {
  assert.deepEqual(buildNotificationCampaignDraftMutationReceipt({
    campaignId: "summer-test",
    status: "draft",
    created: true,
    targetAudience: "marketing_opt_in_users",
  }), {
    ok: true,
    created: true,
    campaignId: "summer-test",
    status: "draft",
    targetAudience: "marketing_opt_in_users",
    sendBlocked: false,
    sendBlockedReason: "",
    deliveryLocked: false,
    sendState: NOTIFICATION_CAMPAIGN_SEND_STATE,
  });
});

test("buildNotificationCampaignBroadcast helpers mark sent campaigns", () => {
  const sentAt = new Date("2026-06-01T10:00:00.000Z");
  assert.deepEqual(buildNotificationCampaignBroadcastUpdateValue({
    actorUid: "admin-1",
    queuedCount: 3,
    timestamp: sentAt,
  }), {
    status: "sent",
    sendBlocked: true,
    sendBlockedReason: "campaign-already-sent",
    deliveryLocked: true,
    sendState: "sent",
    sentAt,
    sentByUid: "admin-1",
    queuedCount: 3,
    updatedAt: sentAt,
    updatedByUid: "admin-1",
    updateSource: "admin-mobile-notification-campaigns",
  });

  assert.deepEqual(buildNotificationCampaignBroadcastReceipt({
    campaign: {campaignId: "summer-test", targetAudience: "marketing_opt_in_users"},
    queuedCount: 3,
    skippedCount: 1,
    actorUid: "admin-1",
  }), {
    ok: true,
    campaignId: "summer-test",
    status: "sent",
    targetAudience: "marketing_opt_in_users",
    queuedCount: 3,
    skippedCount: 1,
    sentByUid: "admin-1",
    sendBlocked: true,
    sendBlockedReason: "campaign-already-sent",
    deliveryLocked: true,
    sendState: "sent",
  });
});

test("buildAdminNotificationCampaignDrafts normalizes admin campaign list", () => {
  const result = buildAdminNotificationCampaignDrafts([
    doc("archived", {
      campaignId: "archived",
      title: "Arquivada",
      body: "Mensagem antiga",
      targetAudience: "marketing_opt_in_users",
      status: "archived",
      scheduledAtIso: "2026-06-03T09:00:00.000Z",
      updatedAt: "2026-06-01T12:15:00.000Z",
      updatedByUid: "admin-updated",
      archivedAt: {seconds: 1780477200, nanoseconds: 500000000},
      archivedByUid: "admin-archived",
    }),
    doc("draft", {
      title: "Rascunho",
      body: "Mensagem teste",
      targetAudience: "all_users",
      scheduledAt: {toDate: () => new Date("2026-06-02T09:00:00.000Z")},
      sendBlocked: true,
      sendBlockedReason: "campaign-send-not-implemented",
      deliveryLocked: true,
      createdAt: new Date("2026-06-01T10:00:00.000Z"),
      createdByUid: "admin-created",
      updatedAt: {toDate: () => new Date("2026-06-01T11:00:00.000Z")},
      updatedByUid: "admin-updated",
    }),
    doc("incomplete", {
      title: "",
      body: "Mensagem",
      targetAudience: "test_users",
    }),
  ], [
    doc("delivery-1", {campaignId: "archived", deliveryState: "sent"}),
    doc("delivery-2", {campaignId: "archived", deliveryState: "failed"}),
    doc("delivery-3", {campaignId: "archived", deliveryState: "suppressed"}),
    doc("delivery-4", {campaignId: "archived", deliveryState: "queued"}),
    doc("delivery-5", {campaignId: "another-campaign", deliveryState: "sent"}),
  ]);

  assert.equal(result.source, "firestore");
  assert.deepEqual(result.campaigns.map((campaign) => campaign.campaignId), ["draft", "archived"]);
  assert.equal(result.campaigns[0].status, "draft");
  assert.equal(result.campaigns[0].targetAudience, "marketing_opt_in_users");
  assert.equal(result.campaigns[0].marketingConsentRequired, true);
  assert.equal(result.campaigns[0].scheduledAtIso, "2026-06-02T09:00:00.000Z");
  assert.equal(result.campaigns[0].sendBlocked, false);
  assert.equal(result.campaigns[0].sendBlockedReason, "");
  assert.equal(result.campaigns[0].deliveryLocked, false);
  assert.equal(result.campaigns[0].sendState, NOTIFICATION_CAMPAIGN_SEND_STATE);
  assert.equal(result.campaigns[0].createdAtIso, "2026-06-01T10:00:00.000Z");
  assert.equal(result.campaigns[0].createdByUid, "admin-created");
  assert.equal(result.campaigns[0].updatedAtIso, "2026-06-01T11:00:00.000Z");
  assert.equal(result.campaigns[0].updatedByUid, "admin-updated");
  assert.equal(result.campaigns[1].marketingConsentRequired, true);
  assert.equal(result.campaigns[1].updatedAtIso, "2026-06-01T12:15:00.000Z");
  assert.equal(result.campaigns[1].archivedAtIso, "2026-06-03T09:00:00.500Z");
  assert.equal(result.campaigns[1].archivedByUid, "admin-archived");
  assert.deepEqual(result.campaigns[1].deliverySummary, {
    totalCount: 4,
    sentCount: 1,
    failedCount: 1,
    suppressedCount: 1,
    pendingCount: 1,
  });
});

test("normalizeNotificationCampaignDraft falls back to a safe test audience", () => {
  const campaign = normalizeNotificationCampaignDraft(doc("draft", {
    title: "Teste",
    body: "Mensagem",
    targetAudience: "all_customers",
  }));

  assert.equal(campaign.targetAudience, "test_users");
});

function doc(id, data) {
  return {
    id,
    data: () => data,
  };
}
