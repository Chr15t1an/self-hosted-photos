-- Display version of a photo (JPEG, ~2048 px long edge), made by the uploader like the thumbnail. NULL for videos
-- and for photos uploaded before it existed (run `node cli/photos.mjs backfill-web`). The lightbox falls back to the original.
ALTER TABLE items ADD COLUMN web_key TEXT;
