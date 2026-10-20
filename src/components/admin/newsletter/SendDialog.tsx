'use client';

import type { NewsletterStatusDto } from '@/lib/api/dto';

import Link from 'next/link';

import { POSTAL_WARNING, sendConfirmTitle, senderNote } from './newsletter-api';

// The one-click send confirmation (spec/ui.md §4 "Issue" → Send): "Send to <n> confirmed
// subscribers?" with the sender line, Send now / Cancel. The parent owns the request.

export interface SendDialogProps {
  recipients: number;
  sender: NewsletterStatusDto['sender'];
  pending: boolean;
  /** Fix pass: warn (never block) when the site has no postal address. */
  postalAddressMissing?: boolean;
  onSend: () => void;
  onCancel: () => void;
}

export function SendDialog({ recipients, sender, pending, postalAddressMissing = false, onSend, onCancel }: SendDialogProps) {
  return (
    <div className="admin-dialog__scrim" onMouseDown={(e) => e.target === e.currentTarget && !pending && onCancel()}>
      <div
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="senddlg-title"
        aria-describedby="senddlg-note"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !pending) {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 className="admin-dialog__title" id="senddlg-title">
          {sendConfirmTitle(recipients)}
        </h2>
        <p className="admin-muted" id="senddlg-note">
          {senderNote(sender)}
        </p>
        {postalAddressMissing ? (
          <p className="admin-warn" role="status">
            {POSTAL_WARNING} <Link href="/admin/site">Open Site settings</Link>
          </p>
        ) : null}
        <div className="admin-dialog__actions">
          <button type="button" className="admin-btn admin-btn--primary" disabled={pending} aria-busy={pending} onClick={onSend} autoFocus>
            {pending ? 'Sending…' : 'Send now'}
          </button>
          <button type="button" className="admin-btn admin-btn--ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
