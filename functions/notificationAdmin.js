const {HttpsError} = require("firebase-functions/v2/https");

const TEMPLATE_KEYS = [
  "booking_request",
  "booking_accepted",
  "booking_rejected",
  "booking_expired",
  "booking_cancelled",
  "booking_rescheduled",
  "booking_reminder",
  "review_prompt",
  "admin_pending_booking",
];
const BACKWARD_COMPATIBLE_TEMPLATE_KEYS = new Set([
  "booking_cancelled",
  "booking_rescheduled",
  "admin_pending_booking",
]);

const DEFAULT_NOTIFICATION_TEMPLATES = [
  {
    key: "booking_request",
    label: "Pedido recebido",
    enabled: true,
    title: "Pedido de marcação recebido",
    body: "Recebemos o seu pedido e vamos confirmar a disponibilidade.",
  },
  {
    key: "booking_accepted",
    label: "Marcação aceite",
    enabled: true,
    title: "Marcação confirmada",
    body: "A sua marcação foi confirmada. Até breve!",
  },
  {
    key: "booking_rejected",
    label: "Marcação rejeitada",
    enabled: true,
    title: "Não foi possível confirmar a marcação",
    body: "Não conseguimos confirmar esta marcação. Consulte os detalhes na app.",
  },
  {
    key: "booking_expired",
    label: "Pedido expirado",
    enabled: true,
    title: "Pedido de marcação expirado",
    body: "O pedido expirou antes da confirmação. Pode escolher outro horário na app.",
  },
  {
    key: "booking_cancelled",
    label: "Marcação cancelada",
    enabled: true,
    title: "Marcação cancelada",
    body: "A sua marcação foi cancelada. Pode escolher outro horário na app.",
  },
  {
    key: "booking_rescheduled",
    label: "Marcação remarcada",
    enabled: true,
    title: "Marcação remarcada",
    body: "A sua marcação foi remarcada para {{slotStart}}. Consulte os detalhes na app.",
  },
  {
    key: "booking_reminder",
    label: "Lembrete de marcação",
    enabled: true,
    title: "A sua lavagem está quase a chegar",
    body: "Tem uma marcação em breve. Consulte a hora e morada na app.",
  },
  {
    key: "review_prompt",
    label: "Pedido de avaliação",
    enabled: true,
    title: "Como correu a lavagem?",
    body: "Avalie o serviço para nos ajudar a melhorar.",
  },
  {
    key: "admin_pending_booking",
    label: "Alerta admin de pedido",
    enabled: true,
    title: "Novo pedido de marcação",
    body: "{{customerName}} pediu {{serviceName}} para {{slotStart}}.",
  },
];

const DEFAULT_NOTIFICATION_SETTINGS = {
  bookingStatusEnabled: true,
  appointmentReminderEnabled: true,
  loyaltyEnabled: true,
  adminPendingAlertEnabled: true,
  marketingEnabled: false,
  reminderLeadMinutes: 120,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  quietHoursTimeZone: "Europe/Lisbon",
  templates: DEFAULT_NOTIFICATION_TEMPLATES,
};

const TEST_CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;
const MIN_REMINDER_LEAD_MINUTES = 15;
const MAX_REMINDER_LEAD_MINUTES = 7 * 24 * 60;
const MAX_TEMPLATE_TITLE_LENGTH = 120;
const MAX_TEMPLATE_BODY_LENGTH = 500;
const TimeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TimeZoneRegex = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/;

function settingPayload(data) {
  if (!data || typeof data !== "object") return {};
  const nested = data.value && typeof data.value === "object" ? data.value : null;
  return nested || data;
}

function cleanText(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function requiredText(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new HttpsError("invalid-argument", `${fieldName} is too long`);
  }
  return trimmed;
}

function parseInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
}

function cleanReminderLeadMinutes(value) {
  const parsed = parseInteger(value);
  if (parsed === null) return DEFAULT_NOTIFICATION_SETTINGS.reminderLeadMinutes;
  return Math.min(MAX_REMINDER_LEAD_MINUTES, Math.max(MIN_REMINDER_LEAD_MINUTES, parsed));
}

function requiredReminderLeadMinutes(value) {
  const parsed = parseInteger(value);
  if (
    parsed === null ||
    parsed < MIN_REMINDER_LEAD_MINUTES ||
    parsed > MAX_REMINDER_LEAD_MINUTES
  ) {
    throw new HttpsError(
      "invalid-argument",
      `reminderLeadMinutes must be an integer between ${MIN_REMINDER_LEAD_MINUTES} and ${MAX_REMINDER_LEAD_MINUTES}`,
    );
  }
  return parsed;
}

function cleanQuietHour(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return TimeRegex.test(trimmed) ? trimmed : fallback;
}

function requiredQuietHour(value, fieldName) {
  if (typeof value !== "string" || !TimeRegex.test(value.trim())) {
    throw new HttpsError("invalid-argument", `${fieldName} must be HH:MM`);
  }
  return value.trim();
}

function isSupportedTimeZone(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || !TimeZoneRegex.test(trimmed)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", {timeZone: trimmed}).format(new Date("2026-01-01T00:00:00.000Z"));
    return true;
  } catch {
    return false;
  }
}

function cleanQuietHoursTimeZone(value, fallback) {
  return isSupportedTimeZone(value) ? value.trim() : fallback;
}

function optionalQuietHoursTimeZone(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_NOTIFICATION_SETTINGS.quietHoursTimeZone;
  }
  if (!isSupportedTimeZone(value)) {
    throw new HttpsError("invalid-argument", "quietHoursTimeZone must be a supported IANA time zone");
  }
  return value.trim();
}

function templateFallback(key) {
  return DEFAULT_NOTIFICATION_TEMPLATES.find((template) => template.key === key);
}

function templatesByKey(templates) {
  const map = new Map();
  if (!Array.isArray(templates)) return map;
  for (const template of templates) {
    if (!template || typeof template !== "object") continue;
    const key = String(template.key || "").trim();
    if (TEMPLATE_KEYS.includes(key)) {
      map.set(key, template);
    }
  }
  return map;
}

function buildTemplate(rawTemplate, key) {
  const fallback = templateFallback(key);
  return {
    key,
    label: fallback.label,
    enabled: rawTemplate?.enabled !== false,
    title: cleanText(rawTemplate?.title, fallback.title, MAX_TEMPLATE_TITLE_LENGTH),
    body: cleanText(rawTemplate?.body, fallback.body, MAX_TEMPLATE_BODY_LENGTH),
  };
}

function validateTemplate(rawTemplate, key) {
  if (!rawTemplate || typeof rawTemplate !== "object" || Array.isArray(rawTemplate)) {
    throw new HttpsError("invalid-argument", `template ${key} is required`);
  }
  const fallback = templateFallback(key);
  const rawKey = String(rawTemplate.key || "").trim();
  if (rawKey !== key) {
    throw new HttpsError("invalid-argument", `template key ${key} is required`);
  }
  return {
    key,
    label: fallback.label,
    enabled: rawTemplate.enabled !== false,
    title: requiredText(rawTemplate.title, `template ${key} title`, MAX_TEMPLATE_TITLE_LENGTH),
    body: requiredText(rawTemplate.body, `template ${key} body`, MAX_TEMPLATE_BODY_LENGTH),
  };
}

function buildNotificationSettings(docSnap = null) {
  const source = docSnap?.exists ? settingPayload(docSnap.data()) : settingPayload(docSnap);
  const rawTemplates = templatesByKey(source.templates);
  return {
    bookingStatusEnabled: source.bookingStatusEnabled !== false,
    appointmentReminderEnabled: source.appointmentReminderEnabled !== false,
    loyaltyEnabled: source.loyaltyEnabled !== false,
    adminPendingAlertEnabled: source.adminPendingAlertEnabled !== false,
    marketingEnabled: source.marketingEnabled === true,
    reminderLeadMinutes: cleanReminderLeadMinutes(source.reminderLeadMinutes),
    quietHoursStart: cleanQuietHour(source.quietHoursStart, DEFAULT_NOTIFICATION_SETTINGS.quietHoursStart),
    quietHoursEnd: cleanQuietHour(source.quietHoursEnd, DEFAULT_NOTIFICATION_SETTINGS.quietHoursEnd),
    quietHoursTimeZone: cleanQuietHoursTimeZone(
      source.quietHoursTimeZone,
      DEFAULT_NOTIFICATION_SETTINGS.quietHoursTimeZone,
    ),
    templates: TEMPLATE_KEYS.map((key) => buildTemplate(rawTemplates.get(key), key)),
    source: docSnap?.exists ? "firestore" : "default",
  };
}

function validateNotificationSettingsUpdateInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Notification settings payload is required");
  }

  const rawTemplates = templatesByKey(data.templates);
  const hasRequiredTemplates = TEMPLATE_KEYS.every((key) =>
    rawTemplates.has(key) || BACKWARD_COMPATIBLE_TEMPLATE_KEYS.has(key),
  );
  if (!hasRequiredTemplates) {
    throw new HttpsError("invalid-argument", "All notification templates are required");
  }

  return {
    bookingStatusEnabled: data.bookingStatusEnabled === true,
    appointmentReminderEnabled: data.appointmentReminderEnabled === true,
    loyaltyEnabled: data.loyaltyEnabled === true,
    adminPendingAlertEnabled: data.adminPendingAlertEnabled === true,
    marketingEnabled: data.marketingEnabled === true,
    reminderLeadMinutes: requiredReminderLeadMinutes(data.reminderLeadMinutes),
    quietHoursStart: requiredQuietHour(data.quietHoursStart, "quietHoursStart"),
    quietHoursEnd: requiredQuietHour(data.quietHoursEnd, "quietHoursEnd"),
    quietHoursTimeZone: optionalQuietHoursTimeZone(data.quietHoursTimeZone),
    templates: TEMPLATE_KEYS.map((key) =>
      rawTemplates.has(key) ?
        validateTemplate(rawTemplates.get(key), key) :
        buildTemplate(null, key),
    ),
  };
}

function validateAdminNotificationTestInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Notification test payload is required");
  }

  const templateKey = String(data.templateKey || "").trim();
  const campaignId = String(data.campaignId || "").trim();
  if (campaignId) {
    if (templateKey) {
      throw new HttpsError("invalid-argument", "Choose either templateKey or campaignId");
    }
    if (!TEST_CAMPAIGN_ID_PATTERN.test(campaignId) || campaignId.includes("/")) {
      throw new HttpsError("invalid-argument", "campaignId is invalid");
    }
    return {
      campaignId,
    };
  }

  if (!TEMPLATE_KEYS.includes(templateKey)) {
    throw new HttpsError("invalid-argument", "templateKey is invalid");
  }

  return {
    templateKey,
  };
}

function buildNotificationSettingsValue(settings) {
  return {
    bookingStatusEnabled: settings.bookingStatusEnabled,
    appointmentReminderEnabled: settings.appointmentReminderEnabled,
    loyaltyEnabled: settings.loyaltyEnabled,
    adminPendingAlertEnabled: settings.adminPendingAlertEnabled,
    marketingEnabled: settings.marketingEnabled,
    reminderLeadMinutes: settings.reminderLeadMinutes,
    quietHoursStart: settings.quietHoursStart,
    quietHoursEnd: settings.quietHoursEnd,
    quietHoursTimeZone: settings.quietHoursTimeZone,
    templates: settings.templates.map((template) => ({
      key: template.key,
      label: template.label,
      enabled: template.enabled,
      title: template.title,
      body: template.body,
    })),
  };
}

module.exports = {
  DEFAULT_NOTIFICATION_SETTINGS,
  TEMPLATE_KEYS,
  buildNotificationSettings,
  buildNotificationSettingsValue,
  validateAdminNotificationTestInput,
  validateNotificationSettingsUpdateInput,
};
