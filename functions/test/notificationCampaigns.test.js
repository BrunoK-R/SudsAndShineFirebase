const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON,
  buildAdminNotificationCampaignDrafts,
  buildNotificationCampaignDraftArchiveValue,
  buildNotificationCampaignDraftMutationReceipt,
  buildNotificationCampaignDraftValue,
  normalizeNotificationCampaignDraft,
  validateNotificationCampaignDraftArchiveInput,
  validateNotificationCampaignDraftInput,
} = require("../notificationCampaigns");

const NOW = new Date("2026-06-01T09:00:00.000Z");

test("validateNotificationCampaignDraftInput builds safe draft-only campaign documents", () => {
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
  assert.equal(draft.sendBlocked, true);
  assert.equal(draft.sendBlockedReason, NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON);

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
    sendBlocked: true,
    sendBlockedReason: NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON,
    deliveryLocked: true,
    sendState: "draft_only",
    updateSource: "admin-mobile-notification-campaigns",
  });
});

test("validateNotificationCampaignDraftInput uses generated safe ids for new drafts", () => {
  const draft = validateNotificationCampaignDraftInput(
    {
      title: "Teste",
      body: "Mensagem para equipa",
      targetAudience: "test_users",
    },
    "generated-safe-id",
    NOW,
  );

  assert.equal(draft.campaignId, "generated-safe-id");
  assert.equal(draft.targetAudience, "test_users");
  assert.equal(draft.marketingConsentRequired, false);
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

test("buildNotificationCampaignDraftArchiveValue keeps archived campaigns send locked", () => {
  assert.deepEqual(buildNotificationCampaignDraftArchiveValue(), {
    status: "archived",
    sendBlocked: true,
    sendBlockedReason: NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON,
    deliveryLocked: true,
    sendState: "draft_only",
    updateSource: "admin-mobile-notification-campaigns",
  });
});

test("buildNotificationCampaignDraftMutationReceipt reports blocked send state", () => {
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
    sendBlocked: true,
    sendBlockedReason: NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON,
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
      targetAudience: "test_users",
      scheduledAt: {toDate: () => new Date("2026-06-02T09:00:00.000Z")},
      sendBlockedReason: "",
      createdAt: new Date("2026-06-01T10:00:00.000Z"),
      createdByUid: "admin-created",
      updatedAt: {toDate: () => new Date("2026-06-01T11:00:00.000Z")},
      updatedByUid: "admin-updated",
      sendBlocked: false,
    }),
    doc("incomplete", {
      title: "",
      body: "Mensagem",
      targetAudience: "test_users",
    }),
  ]);

  assert.equal(result.source, "firestore");
  assert.deepEqual(result.campaigns.map((campaign) => campaign.campaignId), ["draft", "archived"]);
  assert.equal(result.campaigns[0].status, "draft");
  assert.equal(result.campaigns[0].scheduledAtIso, "2026-06-02T09:00:00.000Z");
  assert.equal(result.campaigns[0].sendBlocked, true);
  assert.equal(result.campaigns[0].sendBlockedReason, NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON);
  assert.equal(result.campaigns[0].createdAtIso, "2026-06-01T10:00:00.000Z");
  assert.equal(result.campaigns[0].createdByUid, "admin-created");
  assert.equal(result.campaigns[0].updatedAtIso, "2026-06-01T11:00:00.000Z");
  assert.equal(result.campaigns[0].updatedByUid, "admin-updated");
  assert.equal(result.campaigns[1].marketingConsentRequired, true);
  assert.equal(result.campaigns[1].updatedAtIso, "2026-06-01T12:15:00.000Z");
  assert.equal(result.campaigns[1].archivedAtIso, "2026-06-03T09:00:00.500Z");
  assert.equal(result.campaigns[1].archivedByUid, "admin-archived");
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
