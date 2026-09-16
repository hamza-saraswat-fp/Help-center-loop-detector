# Calibration report

Date: 2026-09-16
Docs sha: 275fd8443b85daa87758916f6908aab3ef94fd5f
Model: anthropic/claude-sonnet-4.5
Prompt version: 1.0.0
Failed checks (excluded from the rate): 0

## Gate: FAIL. Control false positive rate 26.7% (4/15 scored) is over the 10% limit.

## Control cohort

| verdict | count | pct |
| --- | --- | --- |
| MISSING | 4 | 26.7% |
| NOT_A_GAP | 11 | 73.3% |

## Gap cohort

| verdict | count | pct |
| --- | --- | --- |
| HIDDEN | 1 | 6.7% |
| MISSING | 9 | 60.0% |
| NOT_A_GAP | 4 | 26.7% |
| UNFINDABLE | 1 | 6.7% |

Gap cohort HIDDEN hits: 1

## Gap cohort by quota key

| quota_key | total | not found (MISSING/UNFINDABLE/HIDDEN) |
| --- | --- | --- |
| escalation | 5 | 4 |
| model_detected | 10 | 7 |

## Control false positives

| case_id | question | verdict | confidence | target path | first claim |
| --- | --- | --- | --- | --- | --- |
| ctl-001 | When you generate a job report with site visits are the site visit field notes supposed to appear on the job report too? | MISSING | 85 |  | omitted: Site visit field notes do not automatically appear on job reports |
| ctl-005 | Hi team, did we remove the toggle option for including Wisetack as a payment option?
Are qualified invoices now automati... | MISSING | 85 |  | omitted: The per-invoice/per-estimate Wisetack toggle was removed. |
| ctl-006 | Are FP Payments/Rainforest emails sent to founding user only or is it to all admins? | MISSING | 75 |  | omitted: Most FP Payments / Rainforest emails go to all admins |
| ctl-012 | Why can I not see the option to choose a status workflow when creating a new job? | MISSING | 85 |  | omitted: The custom status workflow dropdown only shows on job creation if the account has more than... |

## Control cohort details

| case_id | verdict | target path | cited read |
| --- | --- | --- | --- |
| ctl-001 | MISSING |  | cited read: 3/3 |
| ctl-002 | NOT_A_GAP | integrations-partners/accounting/quickbooks-online/pre-sync-quickbooks-online.mdx | cited read: 1/2 |
| ctl-003 | NOT_A_GAP | troubleshooting-technical-specs/character-limits-validations.mdx | cited read: 4/4 |
| ctl-004 | NOT_A_GAP | offline-mode/estimates-invoices-offline-mode.mdx | cited read: 1/3 |
| ctl-005 | MISSING |  | cited read: 1/1 |
| ctl-006 | MISSING |  | cited read: 5/5 |
| ctl-007 | NOT_A_GAP | using-fieldpulse/communications-notifications/customer-communications.mdx | cited read: 2/2 |
| ctl-008 | NOT_A_GAP | using-fieldpulse/communications-notifications/customer-notification-preferences.mdx | cited read: 1/1 |
| ctl-009 | NOT_A_GAP | using-fieldpulse/item-list-inventory/deducting-inventory-inventory-count.mdx | cited read: 1/1 |
| ctl-010 | NOT_A_GAP |  | cited read: 2/2 |
| ctl-011 | NOT_A_GAP | offline-mode/estimates-invoices-offline-mode.mdx | cited read: 1/4 |
| ctl-012 | MISSING |  | cited read: 2/2 |
| ctl-013 | NOT_A_GAP | features-add-ons/engage-phone-system/set-up-configuration/phone-line-settings.mdx | cited read: 1/1 |
| ctl-014 | NOT_A_GAP | using-fieldpulse/payments/payment-provider-options.mdx | cited read: 1/1 |
| ctl-015 | NOT_A_GAP | using-fieldpulse/reporting/raw-data-reporting-tutorials/invoice-reports.mdx | cited read: 3/3 |

## Gap cohort HIDDEN hits

| case_id | question | confidence | target path |
| --- | --- | --- | --- |
| gap-014 | after a purchase order is sent, can it be edited and resent? | 95 | unparented/can-i-resend-purchase-orders-to-vendors-after-they-have-already-been-sent.mdx |
