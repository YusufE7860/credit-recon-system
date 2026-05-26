// String constants for the `type` column on Notification. Frontend
// can use these to render type-specific icons/colors if desired.
export const NotificationType = {
  EDIT_REQUEST_APPROVED: 'EDIT_REQUEST_APPROVED',
  EDIT_REQUEST_REJECTED: 'EDIT_REQUEST_REJECTED',
  EDIT_REQUEST_CREATED: 'EDIT_REQUEST_CREATED', // sent to admins when user files one
  CARD_ASSIGNED: 'CARD_ASSIGNED',
  RECON_COMPLETE: 'RECON_COMPLETE',
  // Admin nudge: "please upload an invoice for this unmatched transaction".
  INVOICE_REQUESTED: 'INVOICE_REQUESTED',
} as const;

export type NotificationType =
  (typeof NotificationType)[keyof typeof NotificationType];
