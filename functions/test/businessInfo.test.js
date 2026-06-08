const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BUSINESS_INFO,
  buildBusinessInfoSettingValue,
  buildBusinessInfo,
  normalizeFaq,
  normalizeOpeningHours,
  normalizeSocialLinks,
  normalizeStats,
  validateBusinessInfoUpdateInput,
} = require("../businessInfo");

function doc(data) {
  return {
    exists: true,
    data: () => data,
  };
}

test("buildBusinessInfo returns defaults when Firestore setting is missing", () => {
  const info = buildBusinessInfo(null);

  assert.equal(info.source, "default");
  assert.equal(info.phone, DEFAULT_BUSINESS_INFO.phone);
  assert.equal(info.addressLine1, "Rua Virgílio Vieira da Cunha, R. Pte. das Mestras, 2400-447");
  assert.equal(info.openingHours.length, 3);
  assert.equal(info.faq.length, 6);
});

test("buildBusinessInfo normalizes nested business setting value", () => {
  const info = buildBusinessInfo(
    doc({
      key: "business_info",
      updatedAt: new Date("2026-06-01T10:15:00.000Z"),
      updatedByUid: " admin-updated ",
      value: {
        contact: {
          phone: " 244 000 111 ",
          email: " geral@example.pt ",
          whatsappUri: " https://wa.me/351244000111 ",
        },
        address: {
          line1: " Rua Nova 10 ",
          line2: " Leiria ",
          mapsUri: " https://maps.example.test ",
        },
        openingHours: [
          {day: "Dias úteis", hours: "10:00 - 18:00"},
          {dayLabel: "Domingo", hoursLabel: "Fechado", closed: true},
        ],
        faq: [
          {question: "Pergunta?", answer: "Resposta."},
          {question: "", answer: "Ignorada."},
        ],
        stats: [
          {value: "900+", label: "Clientes"},
        ],
        socialLinks: [
          {label: "Instagram", uri: " https://instagram.com/sudsshine "},
        ],
      },
    }),
  );

  assert.equal(info.source, "firestore");
  assert.equal(info.phone, "244 000 111");
  assert.equal(info.email, "geral@example.pt");
  assert.equal(info.addressLine1, "Rua Nova 10");
  assert.equal(info.addressLine2, "Leiria");
  assert.equal(info.mapsUri, "https://maps.example.test");
  assert.equal(info.whatsappUri, "https://wa.me/351244000111");
  assert.deepEqual(info.openingHours, [
    {dayLabel: "Dias úteis", hoursLabel: "10:00 - 18:00", closed: false},
    {dayLabel: "Domingo", hoursLabel: "Fechado", closed: true},
  ]);
  assert.deepEqual(info.faq, [{question: "Pergunta?", answer: "Resposta."}]);
  assert.deepEqual(info.stats, [{value: "900+", label: "Clientes"}]);
  assert.deepEqual(info.socialLinks, [{label: "Instagram", uri: "https://instagram.com/sudsshine"}]);
  assert.equal(info.updatedAtIso, "2026-06-01T10:15:00.000Z");
  assert.equal(info.updatedByUid, "admin-updated");
});

test("buildBusinessInfo normalizes timestamp-like audit metadata", () => {
  const fromTimestamp = buildBusinessInfo(doc({
    updatedAt: {seconds: 1780309800, nanoseconds: 500000000},
    updatedByUid: "admin-ts",
    value: DEFAULT_BUSINESS_INFO,
  }));
  const fromString = buildBusinessInfo(doc({
    value: {
      ...DEFAULT_BUSINESS_INFO,
      updatedAt: "2026-06-01T12:45:00.000Z",
      updatedByUid: "admin-string",
    },
  }));

  assert.equal(fromTimestamp.updatedAtIso, "2026-06-01T10:30:00.500Z");
  assert.equal(fromTimestamp.updatedByUid, "admin-ts");
  assert.equal(fromString.updatedAtIso, "2026-06-01T12:45:00.000Z");
  assert.equal(fromString.updatedByUid, "admin-string");
});

test("normalizers fall back when lists contain no usable records", () => {
  assert.deepEqual(normalizeOpeningHours([{day: "", hours: ""}]), DEFAULT_BUSINESS_INFO.openingHours);
  assert.deepEqual(normalizeFaq([{question: "", answer: ""}]), DEFAULT_BUSINESS_INFO.faq);
  assert.deepEqual(normalizeStats([{value: "", label: ""}]), DEFAULT_BUSINESS_INFO.stats);
  assert.deepEqual(normalizeSocialLinks([{label: "", uri: ""}]), DEFAULT_BUSINESS_INFO.socialLinks);
});

test("validateBusinessInfoUpdateInput sanitizes admin updates", () => {
  const info = validateBusinessInfoUpdateInput({
    phone: " +351 913 005 855 ",
    email: " INFO@SUDSSHINE.PT ",
    addressLine1: " Shopping Norte Sul ",
    addressLine2: " Leiria, Portugal ",
    mapsUri: "https://maps.example.test/suds",
    whatsappUri: "https://wa.me/351913005855",
    openingHours: [
      {dayLabel: " Segunda  a Sexta ", hoursLabel: " 09:00 - 19:00 "},
      {day: "Domingo", hours: "Encerrado", closed: true},
    ],
    socialLinks: [
      {label: " Instagram ", uri: "https://instagram.com/sudsshine"},
    ],
  });

  assert.equal(info.phone, "+351 913 005 855");
  assert.equal(info.phoneUri, "tel:+351913005855");
  assert.equal(info.email, "info@sudsshine.pt");
  assert.equal(info.emailUri, "mailto:info@sudsshine.pt");
  assert.deepEqual(info.openingHours, [
    {dayLabel: "Segunda a Sexta", hoursLabel: "09:00 - 19:00", closed: false},
    {dayLabel: "Domingo", hoursLabel: "Encerrado", closed: true},
  ]);
  assert.deepEqual(buildBusinessInfoSettingValue(info).socialLinks, [
    {label: "Instagram", uri: "https://instagram.com/sudsshine"},
  ]);
});

test("validateBusinessInfoUpdateInput rejects unsafe admin updates", () => {
  assert.throws(() => validateBusinessInfoUpdateInput({
    phone: "913005855",
    email: "info@sudsshine.pt",
    addressLine1: "Shopping Norte Sul",
    addressLine2: "Leiria",
    mapsUri: "javascript:alert(1)",
    whatsappUri: "https://wa.me/351913005855",
    openingHours: [{dayLabel: "Segunda", hoursLabel: "09:00 - 19:00"}],
  }), /mapsUri must be a web URL/);

  assert.throws(() => validateBusinessInfoUpdateInput({
    phone: "913005855",
    email: "info@sudsshine.pt",
    addressLine1: "Shopping Norte Sul",
    addressLine2: "Leiria",
    mapsUri: "https://maps.example.test",
    whatsappUri: "https://wa.me/351913005855",
    openingHours: [],
  }), /openingHours must include/);
});
