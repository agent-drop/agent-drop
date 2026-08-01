-- Persist the R2 object key the worker signed at presign time.
--
-- `/api/upload/complete` used to take `dropId` AND `objectKey` as independent
-- inputs from the request body and never checked they belonged to the same row,
-- so a caller holding any valid drop id could complete a multipart upload
-- against an arbitrary key and flip an unrelated drop to `completed`. The row
-- did not carry enough to reconstruct the key server-side (only `r2_prefix`,
-- not the slugified filename), so it is recorded here instead of trusted.
ALTER TABLE drops ADD COLUMN object_key TEXT;
