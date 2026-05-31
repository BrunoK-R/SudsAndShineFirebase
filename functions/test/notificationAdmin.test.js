const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEMPLATE_KEYS,
  buildNotificationSettings,
  buildNotificationSettingsValue,
  validateAdminNotificationTestInput,
  validateNotificationSettingsUpdateInput,
} = require("../notificationAdmin");

test("buildNotificationSettings returns safe defaults when no settings exist", () => {
  const settings = buildNotificationSettings(null);

  assert.equal(settings.bookingStatusEnabled, true);
  assert.equal(settings.appointmentReminderEnabled, true);
  assert.equal(settings.loyaltyEnabled, true);
  assert.equal(settings.adminPendingAlertEnabled, true);
  assert.equal(settings.marketingEnabled, false);
  assert.equal(settings.reminderLeadMinutes, 120);
  assert.equal(settings.quietHoursStart, "22:00");
  assert.equal(settings.quietHoursEnd, "08:00");
  assert.deepEqual(settings.templates.map((template) => template.key), TEMPLATE_KEYS);
  assert.equal(settings.templates.find((template) => template.key === "booking_cancelled").title, "Marcação cancelada");
  assert.equal(settings.templates.find((template) => template.key === "booking_rescheduled").enabled, true);
  assert.equal(
    settings.templates.find((template) => template.key === "admin_pending_booking").title,
    "Novo pedido de marcação",
  );
  assert.equal(settings.source, "default");
});

test("buildNotificationSettings maps nested configured settings", () => {
  const settings = buildNotificationSettings(doc({
    value: {
      bookingStatusEnabled: false,
      appointmentReminderEnabled: true,
      loyaltyEnabled: false,
      adminPendingAlertEnabled: true,
      marketingEnabled: true,
      reminderLeadMinutes: "180",
      quietHoursStart: "21:30",
      quietHoursEnd: "07:15",
      templates: [
        {
          key: "booking_accepted",
          enabled: false,
          title: "  Confirmada  ",
          body: "  Até   breve  ",
        },
      ],
    },
  }));

  assert.equal(settings.bookingStatusEnabled, false);
  assert.equal(settings.loyaltyEnabled, false);
  assert.equal(settings.marketingEnabled, true);
  assert.equal(settings.reminderLeadMinutes, 180);
  assert.equal(settings.quietHoursStart, "21:30");
  assert.equal(settings.quietHoursEnd, "07:15");
  assert.equal(settings.templates.find((template) => template.key === "booking_accepted").enabled, false);
  assert.equal(settings.templates.find((template) => template.key === "booking_accepted").title, "Confirmada");
  assert.equal(settings.templates.find((template) => template.key === "booking_accepted").body, "Até breve");
  assert.equal(settings.templates.find((template) => template.key === "booking_request").enabled, true);
  assert.equal(settings.source, "firestore");
});

test("validateNotificationSettingsUpdateInput sanitizes admin settings", () => {
  const settings = validateNotificationSettingsUpdateInput({
    bookingStatusEnabled: true,
    appointmentReminderEnabled: false,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: true,
    marketingEnabled: false,
    reminderLeadMinutes: "240",
    quietHoursStart: "22:15",
    quietHoursEnd: "08:30",
    templates: TEMPLATE_KEYS.map((key) => ({
      key,
      enabled: key !== "booking_expired",
      title: `  ${key}   title  `,
      body: `  ${key}   body  `,
    })),
  });

  assert.equal(settings.reminderLeadMinutes, 240);
  assert.equal(settings.quietHoursStart, "22:15");
  assert.equal(settings.quietHoursEnd, "08:30");
  assert.equal(settings.templates.find((template) => template.key === "booking_expired").enabled, false);
  assert.equal(settings.templates[0].title, "booking_request title");
  assert.equal(settings.templates[0].body, "booking_request body");
  assert.deepEqual(buildNotificationSettingsValue(settings).templates[0], {
    key: "booking_request",
    label: "Pedido recebido",
    enabled: true,
    title: "booking_request title",
    body: "booking_request body",
  });
});

test("validateNotificationSettingsUpdateInput backfills newly added templates", () => {
  const legacyTemplateKeys = TEMPLATE_KEYS.filter((key) =>
    key !== "booking_cancelled" && key !== "booking_rescheduled" && key !== "admin_pending_booking",
  );
  const settings = validateNotificationSettingsUpdateInput({
    ...validPayload(),
    templates: validPayload().templates.filter((template) => legacyTemplateKeys.includes(template.key)),
  });

  assert.equal(settings.templates.length, TEMPLATE_KEYS.length);
  assert.equal(settings.templates.find((template) => template.key === "booking_cancelled").title, "Marcação cancelada");
  assert.equal(
    settings.templates.find((template) => template.key === "booking_rescheduled").body,
    "A sua marcação foi remarcada para {{slotStart}}. Consulte os detalhes na app.",
  );
  assert.equal(
    settings.templates.find((template) => template.key === "admin_pending_booking").body,
    "{{customerName}} pediu {{serviceName}} para {{slotStart}}.",
  );
});

test("validateNotificationSettingsUpdateInput rejects unsafe settings", () => {
  assert.throws(
    () => validateNotificationSettingsUpdateInput({
      ...validPayload(),
      reminderLeadMinutes: 10,
    }),
    /reminderLeadMinutes/,
  );

  assert.throws(
    () => validateNotificationSettingsUpdateInput({
      ...validPayload(),
      quietHoursStart: "24:00",
    }),
    /quietHoursStart/,
  );

  assert.throws(
    () => validateNotificationSettingsUpdateInput({
      ...validPayload(),
      templates: validPayload().templates.filter((template) => template.key !== "review_prompt"),
    }),
    /All notification templates/,
  );

  assert.throws(
    () => validateNotificationSettingsUpdateInput({
      ...validPayload(),
      templates: validPayload().templates.map((template) => template.key === "booking_request" ?
        {...template, body: ""} :
        template),
    }),
    /booking_request body/,
  );
});

test("validateAdminNotificationTestInput accepts only known template keys", () => {
  assert.deepEqual(
    validateAdminNotificationTestInput({templateKey: " booking_request "}),
    {templateKey: "booking_request"},
  );

  assert.throws(
    () => validateAdminNotificationTestInput({templateKey: "../booking_request"}),
    /templateKey/,
  );

  assert.throws(
    () => validateAdminNotificationTestInput({templateKey: "marketing_campaign"}),
    /templateKey/,
  );
});

function validPayload() {
  return {
    bookingStatusEnabled: true,
    appointmentReminderEnabled: true,
    loyaltyEnabled: true,
    adminPendingAlertEnabled: true,
    marketingEnabled: false,
    reminderLeadMinutes: 120,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    templates: TEMPLATE_KEYS.map((key) => ({
      key,
      enabled: true,
      title: `${key} title`,
      body: `${key} body`,
    })),
  };
}

function doc(data) {
  return {
    exists: true,
    data: () => data,
  };
}
