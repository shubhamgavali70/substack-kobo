# Getting EPUBs onto a Kobo Libra Colour

The system produces standard, DRM-free EPUB 3 files. Kobo devices read these natively. Uploading an EPUB to R2 does **not** sync it to the device; one of the delivery paths below is required.

## Path 1: download on a computer, copy over USB (always works)

1. Open the library on a computer, sign in, press **Download EPUB**.
2. Connect the Kobo with its USB cable and tap **Connect** on the device.
3. Copy the `.epub` file anywhere on the Kobo drive (a `Books/` folder keeps things tidy).
4. Eject the drive. The Kobo imports the book and shows it in **My Books**.

## Path 2: Google Drive or Dropbox from your phone (wireless)

Kobo's current eReaders, including the Libra Colour, can link to a Google Drive or Dropbox account and import non-DRM EPUB/PDF files from it. According to Kobo's help centre this requires firmware 4.37+ for Google Drive and 4.18+ for Dropbox; check **More › Settings › Device information** and update if needed. Verify the exact steps in the current Kobo help articles, since the menus change between firmware versions.

1. On the Kobo: **More › Google Drive** (or **Dropbox**), then follow the on-screen code/sign-in flow. Kobo creates a folder (for Google Drive it is named for Rakuten Kobo) in your cloud account.
2. On your phone: open the library page, tap **Download EPUB**, then use the browser's share/save option to put the file in that folder (Android: Drive app → "Save to Drive"; iOS: Files app → Google Drive/Dropbox location).
3. On the Kobo: **More › Google Drive/Dropbox**, select the file(s) and tap the import/download action, or tap **Sync** on the home screen.

This is the simplest fully wireless workflow: phone → cloud folder → Kobo.

## Path 3: the Kobo web browser (unsupported, may work)

The experimental browser on Kobo devices can sometimes download files directly from a signed-in web page. This is not an officially supported import method and is not relied upon here. If you try it, sign in at `/login` on the device and download from the library.

## Delivery adapters in the code

`src/delivery/types.ts` defines a `DeliveryAdapter`. Only `DirectDownloadDelivery` is implemented. A Google Drive or Dropbox adapter would upload the finished EPUB to the linked folder using those providers' documented OAuth APIs; that requires an OAuth app registration and token storage and is intentionally left as a future, separate integration. The processing pipeline does not need to change for it.

## Cover images

The cover is an SVG generated from the title and publication name. SVG is a core EPUB 3 media type and renders inside the book. Kobo library-grid thumbnails for SVG covers vary by firmware; if you see a generic cover tile in the grid, that is the reason. A rasterized cover would require a PNG encoder with text rendering in the Worker, which is not implemented.

## Troubleshooting on the device

* **Book does not appear after USB copy**: make sure the file ends in `.epub` and that you ejected the drive properly; try **More › Settings › Device information › Repair your Kobo account** as a last resort.
* **Images missing**: the source image host may not be on `ALLOWED_IMAGE_HOSTS`, or the image exceeded the 5 MB / 25 MB budget. The EPUB contains an "[Image unavailable]" note in place of each dropped image.
* **Text looks wrong**: the stylesheet is deliberately minimal; use the Kobo font and margin settings. Hyphenation is enabled.
