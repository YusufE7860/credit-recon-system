"""Build the FFG Recon System user manual as a .docx.

Uses python-docx directly (no XML surgery). Style choices favour
plain-text readability over aesthetic tricks — the goal is a manual
users can print, email, or scroll through on a phone.
"""

import os

from docx import Document
from docx.shared import Pt, RGBColor, Inches, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml.ns import qn
from docx.oxml import OxmlElement


# Where the user drops their screenshots. Any filename listed in
# add_image() calls below that DOESN'T exist here is silently skipped —
# lets the manual build cleanly whether the user has 0, 5, or all 26
# screenshots ready.
IMAGES_DIR = '/sessions/stoic-sleepy-mccarthy/mnt/credit-recon-system/docs/manual-images'


def add_page_break(doc):
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def add_image(doc, filename, caption, max_width_inches=5.5):
    """Insert a screenshot with a caption, or silently skip if the file
    doesn't exist yet. max_width_inches caps oversized captures so they
    don't run off the printable page.

    Extension-tolerant: if the exact filename is missing we try the
    same basename with the sibling extensions (.png/.jpg/.jpeg) so the
    user doesn't have to worry which format their phone saved."""
    path = os.path.join(IMAGES_DIR, filename)
    if not os.path.exists(path):
        base, _ = os.path.splitext(filename)
        for ext in ('.png', '.jpg', '.jpeg', '.PNG', '.JPG', '.JPEG'):
            alt = os.path.join(IMAGES_DIR, base + ext)
            if os.path.exists(alt):
                path = alt
                break
        else:
            return
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run()
    try:
        r.add_picture(path, width=Inches(max_width_inches))
    except Exception as exc:
        # Corrupt file, unreadable format, etc. — print a placeholder
        # note so the user can see something went wrong.
        p.add_run(f'[image "{filename}" could not be loaded: {exc}]').italic = True
        return
    cap = doc.add_paragraph()
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    crun = cap.add_run(f'Figure: {caption}')
    crun.italic = True
    crun.font.size = Pt(9)
    crun.font.color.rgb = RGBColor(0x66, 0x66, 0x66)


def add_tip(doc, label, text, colour='F97316'):
    """Callout box — left border in accent colour, grey top/bottom."""
    p = doc.add_paragraph()
    r1 = p.add_run(f'{label}: ')
    r1.bold = True
    r1.font.color.rgb = RGBColor.from_string(colour)
    p.add_run(text)
    # Add a coloured left border to make it look like a callout.
    pPr = p._p.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    for side, color, sz in [
        ('top', 'CCCCCC', '6'),
        ('bottom', 'CCCCCC', '6'),
        ('left', colour, '18'),
        ('right', 'CCCCCC', '6'),
    ]:
        b = OxmlElement(f'w:{side}')
        b.set(qn('w:val'), 'single')
        b.set(qn('w:sz'), sz)
        b.set(qn('w:space'), '4')
        b.set(qn('w:color'), color)
        pBdr.append(b)
    pPr.append(pBdr)


doc = Document()

# Global default font — Calibri 11 pt to match Word's default and read
# cleanly on printouts.
style = doc.styles['Normal']
style.font.name = 'Calibri'
style.font.size = Pt(11)

# Tighter margins so the manual doesn't sprawl.
for section in doc.sections:
    section.top_margin = Cm(2)
    section.bottom_margin = Cm(2)
    section.left_margin = Cm(2)
    section.right_margin = Cm(2)


# ---------- Cover page ----------
t = doc.add_paragraph()
t.alignment = WD_ALIGN_PARAGRAPH.CENTER
t.paragraph_format.space_before = Pt(180)
r = t.add_run('FFG Recon System')
r.bold = True
r.font.size = Pt(36)

t = doc.add_paragraph()
t.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = t.add_run('User Manual')
r.font.size = Pt(24)
r.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

t = doc.add_paragraph()
t.alignment = WD_ALIGN_PARAGRAPH.CENTER
t.paragraph_format.space_before = Pt(48)
r = t.add_run(
    'Mobile and desktop guide for cardholders, uploaders, '
    'reporters, and administrators.'
)
r.italic = True
r.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
add_page_break(doc)


# ---------- Contents ----------
doc.add_heading('Contents', level=1)
toc = [
    '1. Getting started',
    '2. User roles',
    '3. Using the app on mobile',
    '4. Uploading invoices',
    '5. Matching invoices to transactions',
    '6. The dashboard',
    '7. The Invoices page',
    '8. The Transactions page',
    '9. For Uploaders (assistants)',
    '10. Admin guide',
    '11. Troubleshooting',
]
for entry in toc:
    doc.add_paragraph(entry)
add_page_break(doc)


# ============================================================
# Chapter 1: Getting Started
# ============================================================
doc.add_heading('1. Getting started', level=1)
doc.add_paragraph(
    'The FFG Recon System is where you upload receipts, review your credit '
    'card spend, and (for admins) run the monthly reconciliation. It runs '
    "in any modern web browser, and can also be installed as an app on "
    "your phone."
)

doc.add_heading('Your account', level=2)
doc.add_paragraph('Your administrator creates your account. You will be given:')
for b in [
    'The web address of the app (e.g. http://10.168.1.180:41234 or your company\'s domain).',
    'Your email address (used as your login).',
    'A temporary password.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('First login and password reset', level=2)
for n in [
    'Open the app URL in your browser.',
    'Enter your email address (not case sensitive) and the temporary password.',
    'You will be sent to a "Set your password" screen. Enter a new password '
    '(at least 8 characters) and confirm it. You cannot reuse the temporary password.',
    'Click Set password. You are now logged in.',
]:
    doc.add_paragraph(n, style='List Number')
add_image(doc, '01-login.png', 'The login screen.')
add_image(doc, '02-change-password.png', 'The forced-reset screen after first login.')
add_tip(
    doc, 'Note',
    'The temporary password only works once. If you forget your new password, '
    'use "Forgot password" on the login screen or ask an admin to reset it.'
)

doc.add_heading('Installing the app on your phone', level=2)
doc.add_paragraph(
    'The app is a PWA (Progressive Web App) — it installs to your home '
    'screen and behaves like a native app.'
)

doc.add_heading('Android (Chrome, Edge, Samsung Internet, Brave)', level=3)
for n in [
    'Open the login page.',
    'Tap the "Install app" button under the login form.',
    'Confirm on the system prompt. The app appears on your home screen with the FUSION icon.',
]:
    doc.add_paragraph(n, style='List Number')
add_image(doc, '03-install-android.jpg', 'The Install app button on Android.', max_width_inches=3.5)

doc.add_heading('iPhone / iPad (Safari only)', level=3)
for n in [
    'Open the login page in Safari (Chrome iOS and Firefox iOS will not work — '
    'Apple blocks Add to Home Screen on those).',
    'Tap the Share icon at the bottom.',
    'Scroll down and tap Add to Home Screen.',
    'Tap Add. The app appears on your home screen.',
]:
    doc.add_paragraph(n, style='List Number')
add_image(doc, '04-install-ios.jpg', 'iPhone Share menu — tap Add to Home Screen.', max_width_inches=3.5)

add_tip(
    doc, 'Why install?',
    'The installed app opens without the browser address bar, feels faster, '
    'and remembers your login for longer. All app features work either way.'
)
add_page_break(doc)


# ============================================================
# Chapter 2: User Roles
# ============================================================
doc.add_heading('2. User roles', level=1)
doc.add_paragraph(
    'What you can see and do depends on which role your admin assigned to you.'
)

doc.add_heading('USER (cardholder)', level=2)
doc.add_paragraph(
    'The default role. You are a card owner uploading receipts for the '
    'transactions on your own card.'
)
for b in [
    'See dashboard with your own spend.',
    'Upload invoices to your account.',
    'See only your own invoices and transactions.',
    'Manually match invoices to transactions.',
    'Request edit access on sealed invoices.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('UPLOADER (assistant)', level=2)
doc.add_paragraph(
    'Uploads invoices on behalf of one or more cardholders. Cannot see totals '
    'or amounts (privacy for the cardholder).'
)
for b in [
    'Sidebar only shows Upload and Invoices.',
    'When uploading, must pick the cardholder from a dropdown.',
    "Only sees invoices they themselves uploaded, never the cardholder's other invoices.",
    'All money fields are hidden.',
    'Metadata edits (category, store, notes) require an admin approval unlock.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('REPORTING', level=2)
doc.add_paragraph(
    'Read-only company-wide view. Cannot delete or approve, but can run all reports.'
)
for b in [
    "See everyone's invoices, transactions, and spend.",
    'Upload bank statements.',
    'Generate recon reports.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('ADMIN', level=2)
doc.add_paragraph(
    'Full access. Manages users, cards, categories, settings, and system-level actions.'
)
for b in [
    'Everything REPORTING can do.',
    'Create/edit/deactivate users.',
    'Approve edit requests.',
    'Delete invoices, statements, and recon reports.',
    'Run system updates (Admin → System update).',
]:
    doc.add_paragraph(b, style='List Bullet')
add_page_break(doc)


# ============================================================
# Chapter 3: Using the app on mobile
# ============================================================
doc.add_heading('3. Using the app on mobile', level=1)
doc.add_paragraph(
    'The mobile experience is designed for one-handed use. Navigation is '
    'always at the bottom of the screen, and the most common action — '
    'uploading a receipt — sits in the middle as a raised camera button.'
)

doc.add_heading('The bottom navigation bar', level=2)
for b in [
    'Home (left, four-square icon): your dashboard.',
    'Upload (centre, raised black circle with a camera icon): opens the invoice upload page.',
    'Invoices (right, checkmark icon): list of your invoices.',
]:
    doc.add_paragraph(b, style='List Bullet')
add_image(doc, '05-mobile-home.jpg', 'Mobile home screen with bottom navigation.', max_width_inches=3.5)

doc.add_heading('The top bar', level=2)
for b in [
    'FUSION logo (left): tap to return home.',
    'Bell icon: notifications. A number badge shows unread count.',
    'Your initials in a coloured circle (right): profile menu — access to Transactions, Cards, '
    'Reports, Admin, Settings (based on your role) and Logout.',
]:
    doc.add_paragraph(b, style='List Bullet')
add_image(doc, '06-mobile-topbar.jpg', 'The mobile top bar close-up.', max_width_inches=5)
add_image(doc, '07-profile-menu.jpg', 'Profile chip dropdown showing role-based nav.', max_width_inches=3.5)

doc.add_heading('Home screen', level=2)
doc.add_paragraph('Your dashboard shows:')
for b in [
    'The date range picker at the top (default: this month).',
    'Statement spend: how much your card was actually charged in the period '
    '(only visible once a bank statement has been uploaded).',
    'Invoices uploaded: total value of receipts you have uploaded.',
    'Outstanding receipts: the gap between what you spent and what you have '
    "uploaded receipts for. Highlighted orange when you owe receipts, green when you're caught up.",
    'Reconciliation status: matched / unmatched / pending counts.',
    'Spend by category pie chart.',
    'Recent invoices and transactions.',
]:
    doc.add_paragraph(b, style='List Bullet')
add_page_break(doc)


# ============================================================
# Chapter 4: Uploading invoices
# ============================================================
doc.add_heading('4. Uploading invoices', level=1)
doc.add_paragraph(
    'This is the most common action, so it deserves its own chapter. There '
    'are two ways to get an invoice into the system: take a photo (mobile), '
    'or pick a file from your device.'
)

doc.add_heading('Taking a photo on your phone', level=2)
for n in [
    'Tap the Upload button (centre of the bottom bar).',
    'Tap Take photo — this opens your phone camera. Photograph the receipt as flat and well-lit as possible.',
    'The photo drops into a queue below. You can add more photos before uploading.',
    'For each queued file, fill in: Reason (what the purchase was for — this shows up on the recon report), '
    'Category (which expense category), and Store (which branch / cost centre).',
    'Tap Upload all. The AI reads each receipt and extracts supplier, total, VAT and date.',
    'Wait a few seconds. Each row turns green with "✓ Imported as [supplier name]" when done.',
]:
    doc.add_paragraph(n, style='List Number')
add_image(doc, '08-upload-empty.jpg', 'Upload page before picking a file.', max_width_inches=3.5)
add_image(doc, '09-upload-queue.jpg', 'A queued file with Reason, Category and Store fields.', max_width_inches=3.5)

doc.add_heading('Picking files on desktop', level=2)
for n in [
    'Click the Pick files card.',
    'Select one or more image or PDF files.',
    'Fill in Reason, Category, and Store for each one.',
    'Click Upload all.',
]:
    doc.add_paragraph(n, style='List Number')
add_image(doc, '11-upload-desktop.png', 'Desktop upload page with multiple files queued.')

doc.add_heading('Line splits: one receipt covering multiple categories', level=2)
doc.add_paragraph(
    'If a single receipt has purchases for different departments (e.g. R 500 '
    'IT equipment + R 200 stationery on one Makro slip), split it into lines:'
)
for n in [
    'On a queued file, tap "+ Split into multiple stores or categories".',
    'An inline editor opens with a Line 1 card.',
    'Set Category, Store, and Amount for the first line.',
    'Tap + Add another line to add more.',
    'The sum of all lines must equal the invoice total (shown below the last line).',
]:
    doc.add_paragraph(n, style='List Number')
doc.add_paragraph(
    'When splits exist, the per-item Category and Store dropdowns are '
    'ignored and the split breakdown is used instead.'
)
add_image(doc, '10-upload-splits.jpg', 'Line splits editor expanded on a queued item.', max_width_inches=3.5)

doc.add_heading('What OCR does automatically', level=2)
for b in [
    'Supplier name',
    'Invoice / receipt number',
    'Date',
    'Subtotal, VAT, and total',
    'Currency (used for foreign purchases to convert to ZAR at the historical exchange rate)',
]:
    doc.add_paragraph(b, style='List Bullet')
doc.add_paragraph(
    'If the AI is unsure about any critical field, the invoice is flagged '
    'for review. You can fix it on the detail page.'
)

add_tip(
    doc, 'Amount lock',
    'Once uploaded, the Total, VAT and Subtotal amounts are locked — nobody '
    'can edit them without deleting and re-uploading. This is deliberate: '
    'the recon report must always match the printed receipt exactly.'
)
add_page_break(doc)


# ============================================================
# Chapter 5: Matching invoices to transactions
# ============================================================
doc.add_heading('5. Matching invoices to transactions', level=1)
doc.add_paragraph(
    'An invoice is "matched" when it is linked to the corresponding line on '
    'your bank statement. The system tries to do this automatically, but '
    'sometimes you need to help it.'
)

doc.add_heading('Automatic matching', level=2)
doc.add_paragraph(
    'The moment a statement is uploaded, the system scores every existing '
    'invoice against every unmatched transaction using three signals: '
    'amount, date, and merchant name similarity. If a pair scores high '
    'enough, they are auto-matched.'
)
doc.add_paragraph(
    'The moment an invoice is uploaded, the same scoring runs against the '
    'existing transactions.'
)

doc.add_heading('When to match manually', level=2)
doc.add_paragraph('Some cases need a human decision:')
for b in [
    'The merchant name on the bank differs a lot from the receipt '
    '(e.g. "Facebk *xy23zw" on the statement, "Meta Platforms" on the invoice).',
    'The amount is slightly off due to a tip or a currency-conversion fee.',
    'One statement transaction covers several invoices (splits).',
    'A refund credit note needs to be attached.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('How to match manually', level=2)
for n in [
    'Go to the Invoices page.',
    'Find an invoice with status Pending or Unmatched (orange Match button on the right).',
    'Tap Match. A picker opens showing candidate transactions.',
    'Best guesses are highlighted with a "likely" badge (amount close and date close).',
    'Tap the transaction you want to link. The invoice status flips to Matched.',
]:
    doc.add_paragraph(n, style='List Number')
add_image(doc, '12-invoices-list.png', 'Invoices page with orange Match buttons on pending rows.')
add_image(doc, '13-match-picker.png', 'Manual match picker — "likely" badge on the best candidate.')
add_image(doc, '15-invoice-detail.png', 'Invoice detail page — file preview, kind toggle, credit applied, splits and reconciliation.')

doc.add_heading('Refund / credit note invoices', level=2)
doc.add_paragraph(
    'If a supplier gives you a credit note (money back to your card), open '
    'that invoice and change the Kind toggle from Purchase to Refund. The '
    'system will then match it against negative-amount lines on your bank '
    'statement.'
)

doc.add_heading('Wallet credit applied to a purchase', level=2)
doc.add_paragraph(
    'Some suppliers (Takealot, Amazon) let you apply store credit at '
    'checkout. Only the difference hits your card. Example:'
)
for b in [
    'Order total: R 1,200',
    'Wallet credit applied: R 1,000',
    'Amount charged to card: R 200',
]:
    doc.add_paragraph(b, style='List Bullet')
doc.add_paragraph(
    'Open the invoice. In the "Wallet / store credit applied" field, enter '
    'R 1,000. The system will then match the R 1,200 invoice against the '
    'R 200 statement line.'
)

doc.add_heading('Split invoices (multiple invoices, one transaction)', level=2)
doc.add_paragraph(
    'If you paid for several separate orders in one card swipe (e.g. two '
    'Takealot deliveries billed as one payment), you can stack multiple '
    'invoices onto the same transaction:'
)
for n in [
    'Match the first invoice to the transaction normally.',
    'Open the second invoice, tap Match.',
    'In the picker, the same transaction now shows a purple "partial" badge '
    'saying "R X of R Y already attached" with "R Z to balance".',
    'Tap it to stack the second invoice on. Repeat until the remaining amount reaches zero.',
]:
    doc.add_paragraph(n, style='List Number')
add_image(doc, '14-partial-match.png', 'Picker showing a partially-matched transaction with the balance still to add.')
add_page_break(doc)


# ============================================================
# Chapter 6: The dashboard
# ============================================================
doc.add_heading('6. The dashboard', level=1)
doc.add_paragraph(
    'Everyone with a non-UPLOADER role sees a dashboard. What you see is '
    'scoped to what you own (USER) or the whole company (REPORTING/ADMIN).'
)

doc.add_heading('The date range picker', level=2)
doc.add_paragraph(
    'Defaults to the current calendar month. Use the presets (This month / '
    'Last month / Last 3 months / Year to date) or type the From and To '
    'dates directly.'
)

doc.add_heading('The three stat cards', level=2)
for b in [
    'Statement spend: sum of what your card actually paid. Blank until a '
    'bank statement covering this period has been uploaded.',
    'Invoices uploaded: sum of your receipt totals in ZAR. Available immediately.',
    'Outstanding receipts: the gap. Orange means "upload more receipts to '
    "cover the gap\". Green means \"you're fully covered\". A number greater "
    'than zero means you have unrecorded spend.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('Recon status', level=2)
doc.add_paragraph(
    'Shows how many of your invoices are Matched vs Unmatched vs Pending. '
    'Click any category to see the underlying invoices.'
)

doc.add_heading('Spend by category', level=2)
doc.add_paragraph(
    'A pie chart showing what you spent in each category. Uses the category '
    'set on your matched invoices.'
)
add_image(doc, '16-dashboard-desktop.png', 'Full dashboard on desktop.')
add_image(doc, '17-dashboard-mobile.jpg', 'The same dashboard on mobile.', max_width_inches=3.5)
add_page_break(doc)


# ============================================================
# Chapter 7: The Invoices page
# ============================================================
doc.add_heading('7. The Invoices page', level=1)

doc.add_heading('Filtering and searching', level=2)
for b in [
    'Status filter: All / Pending / Matched / Unmatched / Disputed / Rejected.',
    'Search box: filter by supplier name.',
    'Admin only: filter by user (both cardholder and uploader match).',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('Match column', level=2)
doc.add_paragraph(
    'An orange Match button appears next to any invoice with status Pending '
    'or Unmatched — one tap opens the manual match picker.'
)

doc.add_heading('The invoice detail page', level=2)
doc.add_paragraph('Opens by tapping any row. Shows:')
for b in [
    'The uploaded file preview (image or PDF).',
    'OCR-extracted fields (supplier, invoice number, date, subtotal, VAT, total). '
    'Amounts are always read-only.',
    'Kind toggle (Purchase / Refund).',
    'Wallet credit applied.',
    'Category, cost center, and notes (editable if unlocked).',
    'Line splits panel: split the invoice across multiple categories or stores.',
    'Reconciliation panel: shows the matched transaction (or a Match button when unmatched).',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('Requesting an edit', level=2)
doc.add_paragraph(
    'If OCR captured a field wrong and the invoice is locked, click "Sealed '
    '— Request edit access". Enter a reason and submit. An admin will '
    'approve or reject; once approved you have 24 hours to edit.'
)
add_image(doc, '18-invoices-filters.png', 'Filters at the top of the Invoices page.')
add_page_break(doc)


# ============================================================
# Chapter 8: The Transactions page
# ============================================================
doc.add_heading('8. The Transactions page', level=1)
doc.add_paragraph('Shows the imported lines from your bank statement.')

doc.add_heading('Match-status filter', level=2)
for b in [
    'All: every transaction in the period.',
    'Matched (green): transactions that have an invoice attached, plus bank fees.',
    'Unmatched (red): transactions that still need a receipt.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('Columns', level=2)
for b in [
    'Date: transaction date on the statement.',
    'Merchant: what the bank says.',
    'Statement amount: what the card was charged.',
    'Invoice amount: sum of attached invoices (net of refunds / credits). '
    'If different from statement amount, a warning chip shows the diff.',
    'Category: from the matched invoice.',
    'Status: POSTED, PENDING, etc.',
]:
    doc.add_paragraph(b, style='List Bullet')
add_image(doc, '19-transactions-pills.png', 'Transactions page with the All / Matched / Unmatched pills at the top.')
add_image(doc, '20-transactions-mobile.jpg', 'Same filter pills on mobile.', max_width_inches=3.5)
add_page_break(doc)


# ============================================================
# Chapter 9: For Uploaders (assistants)
# ============================================================
doc.add_heading('9. For Uploaders (assistants)', level=1)
doc.add_paragraph(
    'If your admin assigned you the UPLOADER role, you upload invoices on '
    "behalf of one or more cardholders (drivers, executives, etc.) who don't "
    'manage receipts themselves.'
)

doc.add_heading('The upload flow', level=2)
for n in [
    'Log in. You land on the Upload page.',
    'At the top, an orange card says "Uploading on behalf of *" with a dropdown. '
    'Pick the cardholder this batch is for. If you only manage one person, they are auto-selected.',
    'Take photos or pick files, fill in the same fields as everyone else, and hit Upload all.',
]:
    doc.add_paragraph(n, style='List Number')
add_image(doc, '21-uploader-cardholder.jpg', 'UPLOADER upload page with the cardholder selector.', max_width_inches=3.5)

doc.add_heading('What you can and cannot see', level=2)
for b in [
    "You see ONLY invoices you uploaded yourself — not the cardholder's other receipts.",
    'You never see money figures (Total, VAT, statement amount, dashboard totals).',
    'You can edit metadata (category, store, notes) only after requesting access from an admin.',
    'The dashboard, transactions, cards and reports pages are hidden from your sidebar.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('Requesting a metadata edit', level=2)
doc.add_paragraph(
    'If you need to correct the category or store on an invoice you '
    'uploaded, click "Sealed — Request edit access" on the invoice detail '
    'page. Enter what you want to change and why. An admin will approve or '
    'reject; once approved you have 24 hours to make the edit.'
)
add_page_break(doc)


# ============================================================
# Chapter 10: Admin guide
# ============================================================
doc.add_heading('10. Admin guide', level=1)
doc.add_paragraph(
    'This chapter is for ADMIN role holders. REPORTING role covers much of '
    'the same reading, but write actions (create/delete) are ADMIN-only.'
)

add_image(doc, '22-admin-home.png', 'The admin home page tile grid.')

doc.add_heading('Managing users', level=2)
doc.add_paragraph('Admin → Users:')
for b in [
    'New user: enter name, email, temp password, role.',
    'For UPLOADER role: tick the cardholders they upload for.',
    'New users automatically get "Must reset password" — they are forced to change on first login.',
    "Change role / deactivate / reset password from any user's row.",
    'Deactivated users cannot log in but their data is preserved for audit.',
]:
    doc.add_paragraph(b, style='List Bullet')
add_image(doc, '23-users-list.png', 'Admin → Users list.')

doc.add_heading('Managing cards', level=2)
doc.add_paragraph(
    'Cards → Add card: label, masked number, last 4, cardholder name, '
    'assigned user (optional).'
)
doc.add_paragraph(
    'Cards are also auto-created when a statement is imported (the system '
    'reads the card sections). Assign auto-created cards to users so their '
    'invoices attribute correctly.'
)
doc.add_paragraph(
    'Merge is a recovery tool: if two Card rows exist for the same physical '
    'card, click Merge on the one you want to keep, then click "Merge into '
    'target" on the duplicate.'
)

doc.add_heading('Uploading statements', level=2)
doc.add_paragraph('Upload → Statement:')
for n in [
    'Drop the bank statement PDF or CSV.',
    'The name and period are auto-detected from the file.',
    'Click Upload. The system parses card sections, creates transactions per card, '
    'and auto-attributes them to the assigned user (or flags them for you to route).',
    'The auto-reconciliation engine runs immediately after import — any existing invoices '
    'matching the new transactions get linked.',
]:
    doc.add_paragraph(n, style='List Number')

doc.add_heading('Categories and stores', level=2)
doc.add_paragraph(
    'Admin → Categories: manage the FFG chart-of-accounts (Computer '
    'Expenses, Stationery, etc.). Deactivating a category keeps historical '
    'invoices tagged but removes it from new-upload dropdowns.'
)
doc.add_paragraph('Admin → Stores: same, for cost centres / departments.')

doc.add_heading('Recon reports', level=2)
doc.add_paragraph('Reports → Recon tab:')
for b in [
    'Admin recon generator (top of tab): pick source (statement or date range), '
    'scope (all users combined, or per-user), then generate.',
    '"Generate for each cardholder": creates one snapshot per user in one click.',
    'Each snapshot in the table has Monthly (per-card listing) and Pivot '
    '(category → department summary) downloads.',
    'Delete a snapshot with the red Delete link. Underlying data is untouched.',
]:
    doc.add_paragraph(b, style='List Bullet')
add_image(doc, '24-recon-generator.png', 'Admin recon generator panel at the top of Reports → Recon tab.')
add_image(doc, '25-recon-reports-list.png', 'Saved recon reports with Monthly / Pivot / Delete actions.')

doc.add_heading('System updates', level=2)
doc.add_paragraph('Admin → System update:')
for n in [
    'Click "Check for updates" — this asks GitHub whether a new version is available.',
    'If a new version is available, click "Update now". The system pulls, rebuilds, '
    'and restarts (2-5 minutes).',
    'A terminal-style log shows progress. The page auto-reloads when the app comes back online.',
]:
    doc.add_paragraph(n, style='List Number')
add_image(doc, '26-system-update.png', 'Admin → System update page with current version and Update now button.')
add_page_break(doc)


# ============================================================
# Chapter 11: Troubleshooting
# ============================================================
doc.add_heading('11. Troubleshooting', level=1)

doc.add_heading("I can't log in", level=2)
for b in [
    'Check your email address (not case sensitive) and password.',
    'If you just changed your password on another device, use the new one.',
    'If the login button spins with no error, your admin probably restarted the server. Wait 30 seconds and retry.',
    "If you get \"Bad credentials\", try Forgot password — you'll receive a reset link "
    '(if email is configured) or an admin can reset you directly.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('OCR misread the amount / supplier', level=2)
for b in [
    'Amounts are permanently locked. Delete the invoice and re-upload with a clearer photo.',
    'Supplier / invoice number / date can be edited if the invoice is still marked "Requires review".',
    "If it's no longer marked for review, click \"Sealed — Request edit access\" and give a reason. "
    'An admin will unlock it for 24 hours.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading('My session timed out', level=2)
doc.add_paragraph(
    'Sessions expire after 10 minutes of inactivity for security. If you '
    "leave the app open and idle for more than 10 minutes, you'll be sent "
    'back to the login screen. Just log in again — your work is saved on the server.'
)

doc.add_heading("The photo I took doesn't upload", level=2)
for b in [
    'Check your internet connection.',
    'iPhone HEIC photos are supported but may take a few seconds longer.',
    'If the file is over 30 MB, resize or compress it first.',
    'If nothing happens after tapping Upload all, refresh the page and try again.',
]:
    doc.add_paragraph(b, style='List Bullet')

doc.add_heading("The Match button doesn't show", level=2)
doc.add_paragraph(
    'The Match button only appears on invoices with status Pending or '
    'Unmatched. If your invoice already says Matched, it is already linked '
    '— open it to see or change the linked transaction.'
)

doc.add_heading('I need admin help', level=2)
doc.add_paragraph(
    "Contact your organisation's admin. They can reset passwords, unlock "
    'invoices, change roles, and delete accidental uploads.'
)


# Footer
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(24)
r = p.add_run('— End of manual —')
r.italic = True
r.font.color.rgb = RGBColor(0x99, 0x99, 0x99)


out = '/sessions/stoic-sleepy-mccarthy/mnt/outputs/FFG-Recon-User-Manual.docx'
doc.save(out)
print(f'Wrote {out}')
