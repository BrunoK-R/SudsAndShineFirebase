const {HttpsError} = require("firebase-functions/v2/https");

const NOTIFICATION_CAMPAIGN_DRAFTS_COLLECTION = "notification_campaign_drafts";
const NOTIFICATION_CAMPAIGNS_COLLECTION = NOTIFICATION_CAMPAIGN_DRAFTS_COLLECTION;
const NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON = "campaign-send-not-implemented";
const NOTIFICATION_CAMPAIGN_SEND_STATE = "ready";
const NOTIFICATION_CAMPAIGN_SENT_STATE = "sent";
const NOTIFICATION_CAMPAIGN_UPDATE_SOURCE = "admin-mobile-notification-campaigns";

const TARGET_AUDIENCE_TEST_USERS = "test_users";
const TARGET_AUDIENCE_MARKETING_OPT_IN_USERS = "marketing_opt_in_users";
const ALLOWED_TARGET_AUDIENCES = new Set([
  TARGET_AUDIENCE_TEST_USERS,
  TARGET_AUDIENCE_MARKETING_OPT_IN_USERS,
]);
const MIN_SCHEDULE_LEAD_MINUTES = 5;
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 1000;
const MAX_NOTES_LENGTH = 500;
const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;

function cleanRequiredText(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  if (text.length > maxLength) {
    throw new HttpsError("invalid-argument", `${fieldName} is too long`);
  }
  return text;
}

function cleanOptionalText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizeCampaignId(value, fallbackId) {
  const campaignId = typeof value === "string" && value.trim() ? value.trim() : fallbackId;
  if (!CAMPAIGN_ID_PATTERN.test(campaignId) || campaignId.includes("/")) {
    throw new HttpsError("invalid-argument", "campaignId is invalid");
  }
  return campaignId;
}

function normalizeTargetAudience(value) {
  const targetAudience = typeof value === "string" ? value.trim() : "";
  // Existing drafts used `all_users`. Treat them as consent-scoped marketing
  // campaigns so a legacy value can never broaden the recipient audience.
  if (targetAudience === "all_users") return TARGET_AUDIENCE_MARKETING_OPT_IN_USERS;
  return ALLOWED_TARGET_AUDIENCES.has(targetAudience) ? targetAudience : TARGET_AUDIENCE_TEST_USERS;
}

function requireTargetAudience(value) {
  const targetAudience = typeof value === "string" ? value.trim() : "";
  if (targetAudience === "all_users") return TARGET_AUDIENCE_MARKETING_OPT_IN_USERS;
  if (!ALLOWED_TARGET_AUDIENCES.has(targetAudience)) {
    throw new HttpsError("invalid-argument", "targetAudience is invalid");
  }
  return targetAudience;
}

function normalizeChannels(data = {}) {
  const rawChannels = Array.isArray(data.channels) ? data.channels : [];
  const rawChannelConfig = data.channels && typeof data.channels === "object" && !Array.isArray(data.channels) ?
    data.channels :
    {};
  const rawChannel = typeof data.channel === "string" ? data.channel.trim().toLowerCase() : "";
  const pushEnabled =
    rawChannels.includes("push") ||
    rawChannelConfig.push === true ||
    rawChannel === "push" ||
    data.pushEnabled === true;
  if (
    rawChannels.includes("email") ||
    rawChannels.includes("sms") ||
    rawChannelConfig.email === true ||
    rawChannelConfig.sms === true ||
    rawChannel === "email" ||
    rawChannel === "sms"
  ) {
    throw new HttpsError("invalid-argument", "Only push campaign drafts are supported");
  }
  if (
    rawChannels.length > 0 ||
    Object.keys(rawChannelConfig).length > 0 ||
    rawChannel ||
    data.pushEnabled !== undefined
  ) {
    if (!pushEnabled) {
      throw new HttpsError("invalid-argument", "push channel must be enabled");
    }
  }
  return ["push"];
}

function parseScheduledAtIso(value, now = new Date()) {
  if (value === undefined || value === null || value === "") {
    return {
      scheduledAtIso: "",
      scheduledAt: null,
    };
  }
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "scheduledAtIso must be a valid ISO date");
  }
  const scheduledAtIso = value.trim();
  const scheduledAt = new Date(scheduledAtIso);
  if (!scheduledAtIso || Number.isNaN(scheduledAt.getTime()) || scheduledAt.toISOString() !== scheduledAtIso) {
    throw new HttpsError("invalid-argument", "scheduledAtIso must be a valid ISO date");
  }
  const minimumTime = now.getTime() + MIN_SCHEDULE_LEAD_MINUTES * 60 * 1000;
  if (scheduledAt.getTime() < minimumTime) {
    throw new HttpsError(
      "invalid-argument",
      `scheduledAtIso must be at least ${MIN_SCHEDULE_LEAD_MINUTES} minutes in the future`,
    );
  }
  return {
    scheduledAtIso,
    scheduledAt,
  };
}

function scheduledAtIsoFromValue(data = {}) {
  const rawTimestamp = data.scheduledAt;
  if (rawTimestamp && typeof rawTimestamp.toDate === "function") {
    const scheduledAt = rawTimestamp.toDate();
    return Number.isNaN(scheduledAt.getTime()) ? "" : scheduledAt.toISOString();
  }
  if (rawTimestamp instanceof Date && !Number.isNaN(rawTimestamp.getTime())) {
    return rawTimestamp.toISOString();
  }
  if (typeof data.scheduledAtIso === "string") {
    const date = new Date(data.scheduledAtIso.trim());
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  return "";
}

function timestampToIso(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value.toDate === "function") {
    const parsed = value.toDate();
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : "";
  }
  if (Number.isFinite(value.seconds)) {
    const nanoseconds = Number.isFinite(value.nanoseconds) ? value.nanoseconds : 0;
    const parsed = new Date(value.seconds * 1000 + Math.floor(nanoseconds / 1000000));
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  return "";
}

function validateNotificationCampaignDraftInput(data = {}, fallbackId = "", now = new Date()) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Notification campaign draft payload is required");
  }
  const campaignId = normalizeCampaignId(data.campaignId || data.id, fallbackId);
  const targetAudience = requireTargetAudience(data.targetAudience);
  const schedule = parseScheduledAtIso(data.scheduledAtIso, now);
  const marketingConsentRequired =
    targetAudience === TARGET_AUDIENCE_MARKETING_OPT_IN_USERS ||
    data.marketingConsentRequired === true;

  const draft = {
    campaignId,
    title: cleanRequiredText(data.title, "title", MAX_TITLE_LENGTH),
    body: cleanRequiredText(data.body, "body", MAX_BODY_LENGTH),
    targetAudience,
    channels: normalizeChannels(data),
    marketingConsentRequired,
    status: "draft",
    scheduledAtIso: schedule.scheduledAtIso,
    scheduledAt: schedule.scheduledAt,
    notes: cleanOptionalText(data.notes, MAX_NOTES_LENGTH),
    sendBlocked: false,
    sendBlockedReason: "",
  };
  draft.document = {
    campaignId: draft.campaignId,
    title: draft.title,
    body: draft.body,
    targetAudience: draft.targetAudience,
    audienceType: draft.targetAudience,
    channels: draft.channels,
    marketingConsentRequired: draft.marketingConsentRequired,
    status: draft.status,
    scheduledAtIso: draft.scheduledAtIso,
    scheduledAt: draft.scheduledAt,
    notes: draft.notes,
    sendBlocked: false,
    sendBlockedReason: "",
    deliveryLocked: false,
    sendState: NOTIFICATION_CAMPAIGN_SEND_STATE,
  };
  return draft;
}

function validateNotificationCampaignDraftArchiveInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Notification campaign archive payload is required");
  }
  return {
    campaignId: normalizeCampaignId(data.campaignId || data.id, ""),
  };
}

function validateNotificationCampaignBroadcastInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Notification campaign broadcast payload is required");
  }
  if (data.confirmBroadcast !== true) {
    throw new HttpsError("failed-precondition", "Campaign broadcast requires explicit confirmation");
  }
  return {
    campaignId: normalizeCampaignId(data.campaignId || data.id, ""),
    confirmBroadcast: true,
  };
}

function assertNotificationCampaignBroadcastReady(campaign, now = new Date()) {
  if (!campaign || typeof campaign !== "object") {
    throw new HttpsError("not-found", "Notification campaign draft not found");
  }
  if (campaign.status !== "draft") {
    throw new HttpsError("failed-precondition", "Only active draft campaigns can be broadcast");
  }
  if (!ALLOWED_TARGET_AUDIENCES.has(campaign.targetAudience)) {
    throw new HttpsError("failed-precondition", "Campaign audience is not safe to broadcast");
  }

  const scheduledAtIso = typeof campaign.scheduledAtIso === "string" ? campaign.scheduledAtIso.trim() : "";
  if (scheduledAtIso) {
    const scheduledAt = new Date(scheduledAtIso);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new HttpsError("failed-precondition", "Campaign schedule is invalid");
    }
    if (scheduledAt > now) {
      throw new HttpsError("failed-precondition", "Campaign scheduled time has not been reached");
    }
  }

  return campaign;
}

function buildNotificationCampaignDraftValue(draft) {
  return {
    campaignId: draft.campaignId,
    title: draft.title,
    body: draft.body,
    targetAudience: draft.targetAudience,
    audienceType: draft.targetAudience,
    channels: draft.channels,
    marketingConsentRequired: draft.marketingConsentRequired,
    status: draft.status,
    scheduledAtIso: draft.scheduledAtIso,
    scheduledAt: draft.scheduledAt,
    notes: draft.notes,
    sendBlocked: false,
    sendBlockedReason: "",
    deliveryLocked: false,
    sendState: NOTIFICATION_CAMPAIGN_SEND_STATE,
    updateSource: NOTIFICATION_CAMPAIGN_UPDATE_SOURCE,
  };
}

function buildNotificationCampaignDraftArchiveValue() {
  return {
    status: "archived",
    sendBlocked: true,
    sendBlockedReason: NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON,
    deliveryLocked: true,
    sendState: "archived",
    updateSource: NOTIFICATION_CAMPAIGN_UPDATE_SOURCE,
  };
}

function buildNotificationCampaignBroadcastUpdateValue({
  actorUid = "",
  queuedCount = 0,
  timestamp = new Date(),
} = {}) {
  return {
    status: "sent",
    sendBlocked: true,
    sendBlockedReason: "campaign-already-sent",
    deliveryLocked: true,
    sendState: NOTIFICATION_CAMPAIGN_SENT_STATE,
    sentAt: timestamp,
    sentByUid: actorUid,
    queuedCount,
    updatedAt: timestamp,
    updatedByUid: actorUid,
    updateSource: NOTIFICATION_CAMPAIGN_UPDATE_SOURCE,
  };
}

function buildNotificationCampaignDraftMutationReceipt({
  campaignId,
  status,
  created = false,
  targetAudience = "",
  sendBlocked = false,
  sendBlockedReason = "",
  deliveryLocked = false,
  sendState = NOTIFICATION_CAMPAIGN_SEND_STATE,
}) {
  const archived = status === "archived";
  const sent = status === "sent";
  return {
    ok: true,
    created,
    campaignId,
    status,
    targetAudience,
    sendBlocked: archived || sent || sendBlocked,
    sendBlockedReason: archived ?
      (sendBlockedReason || NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON) :
      sent ? (sendBlockedReason || "campaign-already-sent") : sendBlockedReason,
    deliveryLocked: archived || sent || deliveryLocked,
    sendState: archived ? "archived" : sent ? NOTIFICATION_CAMPAIGN_SENT_STATE : sendState,
  };
}

function buildNotificationCampaignBroadcastReceipt({
  campaign,
  queuedCount,
  skippedCount,
  actorUid = "",
} = {}) {
  return {
    ok: true,
    campaignId: campaign?.campaignId || "",
    status: "sent",
    targetAudience: campaign?.targetAudience || "",
    queuedCount: Number.isFinite(queuedCount) ? Math.max(0, Math.floor(queuedCount)) : 0,
    skippedCount: Number.isFinite(skippedCount) ? Math.max(0, Math.floor(skippedCount)) : 0,
    sentByUid: actorUid,
    sendBlocked: true,
    sendBlockedReason: "campaign-already-sent",
    deliveryLocked: true,
    sendState: NOTIFICATION_CAMPAIGN_SENT_STATE,
  };
}

function normalizeNotificationCampaignDraft(docSnap) {
  const data = docSnap.data() || {};
  const title = typeof data.title === "string" ? data.title.trim().replace(/\s+/g, " ") : "";
  const body = typeof data.body === "string" ? data.body.trim().replace(/\s+/g, " ") : "";
  if (!title || !body) return null;
  const campaignId = typeof data.campaignId === "string" && data.campaignId.trim() ?
    data.campaignId.trim() :
    docSnap.id;
  if (!CAMPAIGN_ID_PATTERN.test(campaignId) || campaignId.includes("/")) return null;

  const targetAudience = normalizeTargetAudience(data.targetAudience);
  const scheduledAtIso = scheduledAtIsoFromValue(data);
  const status = data.status === "archived" ? "archived" : data.status === "sent" ? "sent" : "draft";
  const sent = status === "sent";
  const archived = status === "archived";
  return {
    campaignId,
    title,
    body,
    targetAudience,
    channels: ["push"],
    marketingConsentRequired:
      targetAudience === TARGET_AUDIENCE_MARKETING_OPT_IN_USERS ||
      data.marketingConsentRequired === true,
    status,
    scheduledAtIso,
    notes: cleanOptionalText(data.notes, MAX_NOTES_LENGTH),
    sendBlocked: sent || archived,
    sendBlockedReason: typeof data.sendBlockedReason === "string" && data.sendBlockedReason.trim() ?
      (sent || archived ? data.sendBlockedReason.trim() : "") :
      sent ? "campaign-already-sent" :
        archived ? NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON : "",
    deliveryLocked: sent || archived,
    sendState: typeof data.sendState === "string" && data.sendState.trim() ?
      data.sendState.trim() :
      data.status === "sent" ? NOTIFICATION_CAMPAIGN_SENT_STATE :
        data.status === "archived" ? "archived" : NOTIFICATION_CAMPAIGN_SEND_STATE,
    createdByUid: typeof data.createdByUid === "string" ? data.createdByUid.trim() : "",
    updatedByUid: typeof data.updatedByUid === "string" ? data.updatedByUid.trim() : "",
    archivedByUid: typeof data.archivedByUid === "string" ? data.archivedByUid.trim() : "",
    sentByUid: typeof data.sentByUid === "string" ? data.sentByUid.trim() : "",
    createdAtIso: timestampToIso(data.createdAt),
    updatedAtIso: timestampToIso(data.updatedAt),
    archivedAtIso: timestampToIso(data.archivedAt),
    sentAtIso: timestampToIso(data.sentAt),
    queuedCount: Number.isFinite(data.queuedCount) ? Math.max(0, Math.floor(data.queuedCount)) : 0,
  };
}

function campaignSortKey(campaign) {
  return campaign.status === "draft" ? 0 : 1;
}

function buildAdminNotificationCampaignDrafts(docSnaps = []) {
  const campaigns = (docSnaps || [])
    .map(normalizeNotificationCampaignDraft)
    .filter(Boolean)
    .sort((left, right) => {
      const statusDiff = campaignSortKey(left) - campaignSortKey(right);
      if (statusDiff !== 0) return statusDiff;
      return left.campaignId.localeCompare(right.campaignId);
    });
  return {
    source: campaigns.length > 0 ? "firestore" : "empty",
    campaigns,
  };
}

module.exports = {
  NOTIFICATION_CAMPAIGN_DRAFTS_COLLECTION,
  NOTIFICATION_CAMPAIGNS_COLLECTION,
  NOTIFICATION_CAMPAIGN_SEND_BLOCKED_REASON,
  NOTIFICATION_CAMPAIGN_SEND_STATE,
  NOTIFICATION_CAMPAIGN_SENT_STATE,
  assertNotificationCampaignBroadcastReady,
  buildAdminNotificationCampaignDrafts,
  buildNotificationCampaignBroadcastReceipt,
  buildNotificationCampaignBroadcastUpdateValue,
  buildNotificationCampaignDraftArchiveValue,
  buildNotificationCampaignDraftMutationReceipt,
  buildNotificationCampaignDraftValue,
  normalizeNotificationCampaignDraft,
  validateNotificationCampaignBroadcastInput,
  validateNotificationCampaignArchiveInput: validateNotificationCampaignDraftArchiveInput,
  validateNotificationCampaignDraftArchiveInput,
  validateNotificationCampaignDraftInput,
};
