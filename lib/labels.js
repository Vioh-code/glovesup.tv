// Display words for battle fields, shared by the call out, My battles and
// dashboard views. Keys are the enum values in 02-data-model.
const LABELS = {
  kind: { single: '1v1', team: '3v3' },
  scoring: { elo: 'ELO', fun: 'Just for fun' },
  judging: { official: 'Official judges', popular: 'Popular vote' },
  status: {
    proposed: 'Waiting for reply',
    accepted: 'Accepted',
    declined: 'Declined',
    cancelled: 'Cancelled',
    expired: 'Expired',
    awaiting_panel: 'Waiting for judges',
    submissions_open: 'Submissions open',
    judging: 'Judging',
    finalized: 'Finalized',
    forfeited: 'Forfeited',
    voided: 'Voided',
  },
};

module.exports = { LABELS };
