const {HttpsError} = require("firebase-functions/v2/https");

function normalizeShortText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function assertReservationId(value) {
  const reservationId = normalizeShortText(value, 160);
  if (!reservationId || reservationId.includes("/")) {
    throw new HttpsError("invalid-argument", "reservationId is required");
  }
  return reservationId;
}

function validateReservationReviewInput(data) {
  const input = data || {};
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new HttpsError("invalid-argument", "rating must be between 1 and 5");
  }

  const seenTags = new Set();
  const tags = Array.isArray(input.tags) ?
    input.tags
      .map((tag) => normalizeShortText(tag, 40))
      .filter(Boolean)
      .filter((tag) => {
        const key = tag.toLowerCase();
        if (seenTags.has(key)) return false;
        seenTags.add(key);
        return true;
      })
      .slice(0, 8) :
    [];

  return {
    reservationId: assertReservationId(input.reservationId),
    rating,
    tags,
    comment: normalizeShortText(input.comment, 1000),
  };
}

function buildReservationReviewId(reservationId, uid) {
  const safeUid = String(uid || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 128);
  return `${reservationId}_${safeUid}`.slice(0, 300);
}

function isCancelledStatus(status) {
  return ["cancelled", "canceled", "cancelado"].includes(String(status || "").toLowerCase());
}

function isReservationOwnedByRequester(data, uid, email) {
  const customerUid = String(data.customerUid || "").trim();
  const customerEmail = String(data.customerEmail || "").trim().toLowerCase();
  return customerUid === uid || (!!email && customerEmail === email);
}

function assertReservationReviewable({reservationSnap, uid, email, now = new Date()}) {
  if (!reservationSnap?.exists) {
    throw new HttpsError("not-found", "Reservation not found");
  }

  const data = reservationSnap.data() || {};
  if (!isReservationOwnedByRequester(data, uid, email)) {
    throw new HttpsError("permission-denied", "Reservation does not belong to this user");
  }

  if (isCancelledStatus(data.status)) {
    throw new HttpsError("failed-precondition", "Cancelled reservations cannot be reviewed");
  }

  const slotEnd = new Date(data.slotEnd || data.end_time || data.endTime || "");
  if (Number.isNaN(slotEnd.getTime()) || slotEnd > now) {
    throw new HttpsError("failed-precondition", "Reservation is not ready for review");
  }

  return data;
}

function buildReservationReviewDocument({review, reservationData, uid, email}) {
  return {
    reservationId: review.reservationId,
    reservationCode: String(reservationData.reservationCode || "").trim(),
    customerUid: uid,
    customerEmail: email,
    serviceId: String(reservationData.serviceId || "").trim(),
    serviceName: String(reservationData.serviceName || "").trim(),
    rating: review.rating,
    tags: review.tags,
    comment: review.comment,
    source: "mobile-rating",
    visibility: "internal",
  };
}

module.exports = {
  assertReservationReviewable,
  buildReservationReviewDocument,
  buildReservationReviewId,
  validateReservationReviewInput,
};
