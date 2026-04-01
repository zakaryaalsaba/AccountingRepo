# E-sign file storage

## MVP: local disk

- **`getEsignStorage()`** returns `{ saveFile(buffer, { companyId, originalName, mimeType }) }` → `{ file_url, storage_key, bytes_written }`.
- Files live under **`ESIGN_UPLOAD_DIR`** (default `uploads/esign/{companyId}/`).
- **`file_url`** is built from **`ESIGN_PUBLIC_BASE_URL`** + **`ESIGN_PUBLIC_URL_PATH`** so clients can open or download the file once you expose static/file routes.

## Environment

See `server/.env.example` (`ESIGN_*`).

## Future: S3

Implement `s3Storage.js` with the same `saveFile` contract, switch with `ESIGN_STORAGE_DRIVER=s3`, and map `file_url` to a signed object URL or time-limited signed URL.

## Production / backups (local driver)

Signed PDFs under **`ESIGN_UPLOAD_DIR`** (default `uploads/esign/`) are **not** in PostgreSQL. Treat them like any application file store:

- Include the upload root in **filesystem backups** or **volume snapshots** alongside DB restores; after a DB-only restore, orphaned rows may point at missing files, and files without rows waste disk.
- For Docker/Kubernetes, mount a **persistent volume** for `ESIGN_UPLOAD_DIR`; avoid baking uploads into the image.
- When moving to S3, enable **versioning** and **lifecycle rules** on the bucket if you need retention and compliance alignment with `esign_audit_logs`.
