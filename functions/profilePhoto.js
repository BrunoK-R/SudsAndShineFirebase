const {HttpsError} = require("firebase-functions/v2/https");

const MAX_PROFILE_PHOTO_BYTES = 1_000_000;
const MAX_PROFILE_PHOTO_BASE64_LENGTH = 1_400_000;
const PROFILE_PHOTO_MIME_TYPE = "image/jpeg";

function validateProfilePhotoMutationPayload(data = {}) {
  if (data.remove === true) {
    if (typeof data.imageBase64 === "string" && data.imageBase64.trim()) {
      throw new HttpsError("invalid-argument", "imageBase64 must be omitted when removing a photo");
    }
    return {remove: true, imageBytes: null, mimeType: null};
  }

  const mimeType = String(data.mimeType || "").trim().toLowerCase();
  if (mimeType !== PROFILE_PHOTO_MIME_TYPE) {
    throw new HttpsError("invalid-argument", "Only JPEG profile photos are supported");
  }
  const encodedImage = normalizeBase64(data.imageBase64);
  const imageBytes = Buffer.from(encodedImage, "base64");
  if (imageBytes.length === 0 || imageBytes.length > MAX_PROFILE_PHOTO_BYTES) {
    throw new HttpsError("invalid-argument", "Profile photo must be between 1 byte and 1 MB");
  }
  if (!isJpeg(imageBytes)) {
    throw new HttpsError("invalid-argument", "Profile photo content must be a valid JPEG");
  }

  return {
    remove: false,
    imageBytes,
    mimeType: PROFILE_PHOTO_MIME_TYPE,
  };
}

function normalizeBase64(value) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "imageBase64 is required");
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_PROFILE_PHOTO_BASE64_LENGTH ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    throw new HttpsError("invalid-argument", "imageBase64 is invalid");
  }
  const canonical = Buffer.from(normalized, "base64").toString("base64");
  if (canonical !== normalized) {
    throw new HttpsError("invalid-argument", "imageBase64 is invalid");
  }
  return normalized;
}

function isJpeg(imageBytes) {
  return imageBytes.length >= 4 &&
    imageBytes[0] === 0xff &&
    imageBytes[1] === 0xd8 &&
    imageBytes[2] === 0xff &&
    imageBytes[imageBytes.length - 2] === 0xff &&
    imageBytes[imageBytes.length - 1] === 0xd9;
}

function profilePhotoStoragePath(uid, objectId) {
  const normalizedUid = normalizePathSegment(uid, "uid");
  const normalizedObjectId = normalizePathSegment(objectId, "objectId");
  return `user-profile/${normalizedUid}/avatar/${normalizedObjectId}.jpg`;
}

function profilePhotoDownloadUrl({bucketName, storagePath, downloadToken}) {
  const normalizedBucketName = String(bucketName || "").trim();
  const normalizedStoragePath = String(storagePath || "").trim();
  const normalizedToken = String(downloadToken || "").trim();
  if (!normalizedBucketName || !normalizedStoragePath || !normalizedToken) {
    throw new Error("Profile photo download URL fields are required");
  }
  return "https://firebasestorage.googleapis.com/v0/b/" +
    `${encodeURIComponent(normalizedBucketName)}/o/${encodeURIComponent(normalizedStoragePath)}` +
    `?alt=media&token=${encodeURIComponent(normalizedToken)}`;
}

function isManagedProfilePhotoStoragePath(uid, storagePath) {
  const normalizedUid = String(uid || "").trim();
  const normalizedPath = String(storagePath || "").trim();
  if (!normalizedUid || normalizedUid.includes("/")) return false;
  const prefix = `user-profile/${normalizedUid}/avatar/`;
  if (!normalizedPath.startsWith(prefix)) return false;
  const fileName = normalizedPath.slice(prefix.length);
  return /^[A-Za-z0-9_-]{1,128}\.jpg$/.test(fileName);
}

function normalizePathSegment(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
    throw new Error(`${fieldName} is invalid`);
  }
  return normalized;
}

module.exports = {
  MAX_PROFILE_PHOTO_BYTES,
  PROFILE_PHOTO_MIME_TYPE,
  isManagedProfilePhotoStoragePath,
  profilePhotoDownloadUrl,
  profilePhotoStoragePath,
  validateProfilePhotoMutationPayload,
};
