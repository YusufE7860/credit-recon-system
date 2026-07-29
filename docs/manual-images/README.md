# Manual images — capture checklist

Drop screenshots in this folder using the exact filenames below (case-
sensitive). When you're done, tell me and I'll rebuild the manual so each
image lands at the right spot with a caption.

## How to capture

- **Phone**: use your phone's built-in screenshot function while the
  installed app is open (or the app in Safari/Chrome).
- **Desktop**: use Windows Snipping Tool (Win+Shift+S) or Cmd+Shift+4 on
  Mac to capture the browser window (not the whole screen).
- Save PNG or JPG. Keep resolution reasonable — 1080p wide is plenty; the
  manual scales images down anyway.

Any images you skip will simply be omitted from the manual. Nothing here
is strictly required.

---

## Ch 1 — Getting started

| Filename | What to capture |
|---|---|
| `01-login.png` | The login screen with the email + password fields. |
| `02-change-password.png` | The "Set your password" screen (log in as a new user with `mustResetPassword=true`, or trigger it via SQL). |
| `03-install-android.jpg` | Phone screenshot showing the "Install app" button on the login page (Android Chrome). |
| `04-install-ios.jpg` | iPhone screenshot showing the Share menu with "Add to Home Screen" highlighted. |

## Ch 3 — Mobile app tour

| Filename | What to capture |
|---|---|
| `05-mobile-home.jpg` | Phone screenshot of the Dashboard/Home page with the bottom nav visible. |
| `06-mobile-topbar.jpg` | Phone screenshot showing the top bar close-up (logo + bell + profile chip). |
| `07-profile-menu.jpg` | Phone screenshot with the profile chip dropdown open, showing Transactions / Cards / Reports / Admin / Logout. |

## Ch 4 — Uploading invoices

| Filename | What to capture |
|---|---|
| `08-upload-empty.jpg` | Phone screenshot of the Upload page BEFORE picking a file (Take photo / Pick files tiles). |
| `09-upload-queue.jpg` | Phone screenshot AFTER selecting a photo — showing a queued file with Reason / Category / Store dropdowns. |
| `10-upload-splits.jpg` | Phone screenshot with the "Line splits" panel expanded on a queued item, showing 2-3 split lines. |
| `11-upload-desktop.png` | Desktop browser screenshot of the same Upload page with multiple files queued. |

## Ch 5 — Matching invoices to transactions

| Filename | What to capture |
|---|---|
| `12-invoices-list.png` | Desktop screenshot of the Invoices page showing several rows with the orange "Match" button on some. |
| `13-match-picker.png` | The manual match picker modal open on an invoice, showing candidate transactions with a "likely" badge. |
| `14-partial-match.png` | Match picker on the SECOND of two split invoices, showing a transaction with the purple "partial · N attached" badge and "add R X in purchases" hint. |
| `15-invoice-detail.png` | Full desktop screenshot of an invoice detail page — file preview on the left, fields (kind toggle, credit applied, category, store, notes, line splits, reconciliation) on the right. |

## Ch 6 — Dashboard

| Filename | What to capture |
|---|---|
| `16-dashboard-desktop.png` | Full desktop dashboard with the date picker, three stat cards, and pie chart visible. |
| `17-dashboard-mobile.jpg` | Phone version of the same. |

## Ch 7 — Invoices page

| Filename | What to capture |
|---|---|
| `18-invoices-filters.png` | Desktop screenshot showing status filter dropdown open and the "Uploaded by" filter (admin only). |

## Ch 8 — Transactions page

| Filename | What to capture |
|---|---|
| `19-transactions-pills.png` | Desktop screenshot with the All / Matched / Unmatched pills visible at the top and the table below. Ideally with the Unmatched pill active. |
| `20-transactions-mobile.jpg` | Phone version showing the same pills. |

## Ch 9 — Uploaders

| Filename | What to capture |
|---|---|
| `21-uploader-cardholder.jpg` | Phone screenshot as an UPLOADER user on the Upload page, showing the orange "Uploading on behalf of" card with the cardholder dropdown. |

## Ch 10 — Admin

| Filename | What to capture |
|---|---|
| `22-admin-home.png` | Desktop Admin home page tile grid (Users, Edit Requests, Cards, Stores, Categories, Audit Logs, System update). |
| `23-users-list.png` | Admin → Users page. |
| `24-recon-generator.png` | Reports → Recon tab showing the "Admin recon generator" panel at the top with Source / Scope toggles. |
| `25-recon-reports-list.png` | The saved recon reports table below, with Monthly / Pivot / Delete buttons. |
| `26-system-update.png` | Admin → System update page — showing current version, "Check for updates" and "Update now" buttons. |

## Ch 11 — Troubleshooting

No screenshots required — troubleshooting is text-only steps.

---

Once you've captured what you can, message "manual images ready" and
I'll rebuild `FFG-Recon-User-Manual.docx` with them embedded.
