<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run the geoeditor

`mahala-geoeditor` now reads and writes `mahalas` directly from MySQL through
its own Vite server middleware. It no longer depends on the Laravel API routes.

## Run Locally

**Prerequisites:** Node.js, access to the MySQL database used by `mahala-backend`

1. Install dependencies:
   `npm install`
2. Configure DB access in `.env` using `MAHALA_DB_*` variables if you do not
   want to reuse `../mahala-backend/.env`.
3. Run the editor:
   `npm run dev`

## Notes

- The React app calls `/db/mahalas` and `/db/mahalas/bulk-save` on the same
  origin.
- Those routes are implemented inside `vite.config.ts` via
  [server/mahalaDbPlugin.js](server/mahalaDbPlugin.js).
- If `MAHALA_DB_*` is not set in `mahala-geoeditor`, the editor falls back to
  `../mahala-backend/.env`.
