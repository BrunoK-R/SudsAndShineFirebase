const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BUSINESS_INFO,
  buildBusinessInfo,
  normalizeFaq,
  normalizeOpeningHours,
  normalizeStats,
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
  assert.equal(info.addressLine1, "Shopping Norte Sul, Piso -1");
  assert.equal(info.openingHours.length, 3);
  assert.equal(info.faq.length, 6);
});

test("buildBusinessInfo normalizes nested business setting value", () => {
  const info = buildBusinessInfo(
    doc({
      key: "business_info",
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
});

test("normalizers fall back when lists contain no usable records", () => {
  assert.deepEqual(normalizeOpeningHours([{day: "", hours: ""}]), DEFAULT_BUSINESS_INFO.openingHours);
  assert.deepEqual(normalizeFaq([{question: "", answer: ""}]), DEFAULT_BUSINESS_INFO.faq);
  assert.deepEqual(normalizeStats([{value: "", label: ""}]), DEFAULT_BUSINESS_INFO.stats);
});
