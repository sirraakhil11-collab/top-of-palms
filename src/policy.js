/**
 * Official policy constants for On Top of the Palms
 * Single source of truth — used in emails, forms, and AI agent
 */

const RESTAURANT_NAME = 'On Top of the Palms';
const SEATING_OPTIONS = ['Window', 'Middle', 'Bench', 'Private Room A', 'Private Room B', 'Private Room C'];
const PAYMENT_OPTIONS = ['CC/Cash', 'USF Card', 'Direct Bill'];
const MIN_PARTY = 2;
const MAX_PARTY = 15;
const ADVANCE_HOURS = 24;
const DAILY_LIMIT_COVERS = parseInt(process.env.DAILY_LIMIT || '60');

const POLICY_TEXT = `Thank you for reaching out to ${RESTAURANT_NAME}!

Our office hours are Monday through Friday, 9:00 AM – 5:00 PM. Please allow up to one (1) business day for a response.

Reservation Policy:
• PCard or credit card payments are preferred. For added convenience, you may add your PCard to your Catertrax online wallet before your reservation.
• Direct Bill forms are accepted; payment must be received within 30 days of dining.
• Reservations are available for parties of ${MIN_PARTY} or more (maximum ${MAX_PARTY}).
• We are unable to accept reservations within ${ADVANCE_HOURS} hours of the requested date.
• We accept a limited number of reservations per day; once reached, additional guests are accommodated as walk-ups.
• Same-day and last-minute requests are welcome as walk-ups, based on availability.

Thank you for your interest in dining with us. We look forward to welcoming you On Top of the Palms!

Warm regards,
On Top of the Palms Team`;

module.exports = { RESTAURANT_NAME, SEATING_OPTIONS, PAYMENT_OPTIONS, MIN_PARTY, MAX_PARTY, ADVANCE_HOURS, DAILY_LIMIT_COVERS, POLICY_TEXT };
