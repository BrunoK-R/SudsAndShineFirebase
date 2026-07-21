const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_PROFILE_PHOTO_BYTES,
  PROFILE_PHOTO_MIME_TYPE,
  isManagedProfilePhotoStoragePath,
  profilePhotoDownloadUrl,
  profilePhotoStoragePath,
  validateProfilePhotoMutationPayload,
} = require("../profilePhoto");

function jpegBytes() {
  return Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
}

test("accepts a canonical JPEG upload payload", () => {
  const imageBytes = jpegBytes();
  const result = validateProfilePhotoMutationPayload({
    imageBase64: imageBytes.toString("base64"),
    mimeType: " IMAGE/JPEG ",
  });

  assert.equal(result.remove, false);
  assert.equal(result.mimeType, PROFILE_PHOTO_MIME_TYPE);
  assert.deepEqual(result.imageBytes, imageBytes);
});

test("accepts an explicit removal without image data", () => {
  assert.deepEqual(validateProfilePhotoMutationPayload({remove: true}), {
    remove: true,
    imageBytes: null,
    mimeType: null,
  });
});

test("rejects malformed base64 and mismatched content", () => {
  assert.throws(
    () => validateProfilePhotoMutationPayload({
      imageBase64: "%%%=",
      mimeType: "image/jpeg",
    }),
    /imageBase64 is invalid/,
  );
  assert.throws(
    () => validateProfilePhotoMutationPayload({
      imageBase64: Buffer.from("not-a-jpeg").toString("base64"),
      mimeType: "image/jpeg",
    }),
    /valid JPEG/,
  );
});

test("rejects non-JPEG media types and files larger than one megabyte", () => {
  assert.throws(
    () => validateProfilePhotoMutationPayload({
      imageBase64: jpegBytes().toString("base64"),
      mimeType: "image/png",
    }),
    /Only JPEG/,
  );

  const tooLarge = Buffer.alloc(MAX_PROFILE_PHOTO_BYTES + 1, 0xff);
  assert.throws(
    () => validateProfilePhotoMutationPayload({
      imageBase64: tooLarge.toString("base64"),
      mimeType: "image/jpeg",
    }),
    /between 1 byte and 1 MB/,
  );
});

test("builds owner-scoped object paths and token download URLs", () => {
  const storagePath = profilePhotoStoragePath("user_1", "object-1");
  assert.equal(storagePath, "user-profile/user_1/avatar/object-1.jpg");
  assert.equal(isManagedProfilePhotoStoragePath("user_1", storagePath), true);
  assert.equal(isManagedProfilePhotoStoragePath("user_2", storagePath), false);
  assert.equal(
    profilePhotoDownloadUrl({
      bucketName: "project.firebasestorage.app",
      storagePath,
      downloadToken: "token-1",
    }),
    "https://firebasestorage.googleapis.com/v0/b/project.firebasestorage.app/o/" +
      "user-profile%2Fuser_1%2Favatar%2Fobject-1.jpg?alt=media&token=token-1",
  );
});
