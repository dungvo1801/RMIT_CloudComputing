# Solution Architecture Document

**Project:** SplitEase — Group Expense Splitter
**Student:** s4124370
**Course:** Cloud Computing — Assessment 3

> Fill in the bracketed placeholders below before submission. Export this
> file to Word/PDF as your final submission format (Markdown → PDF via
> Pandoc, or just copy sections into a Word template — either is fine per
> the brief, "make your own format").

## 1. Links

- **Live URL:** http://expense-splitter-site-864419282671-us-east-1.s3-website-us-east-1.amazonaws.com
- **Repository URL:** https://github.com/dungvo1801/RMIT_CloudComputing
- **Public dataset link(s):** N/A — all data is user-generated within the app.

## 2. Summary

SplitEase is a cloud-native, serverless web application that helps groups of
friends, roommates, or shared households track shared expenses, automatically
calculates who owes whom, and surfaces spending trends over time — removing
the manual spreadsheet/mental-math work that usually causes disputes.

## 3. Introduction

### 3.1 Motivation

Groups sharing recurring costs (rent, groceries, utilities, trips) commonly
track who paid for what using memory, chat messages, or ad-hoc spreadsheets.
This is error-prone and creates friction: it's hard to remember every
transaction, harder to agree on a fair split, and hardest of all to reduce a
tangle of individual debts into the minimum number of payments needed to
settle up.

### 3.2 High-level view

Users sign up, create an expense group, and add members by name. Any member
records a transaction ("Alice paid $30 for groceries, split among 3 people"),
optionally attaching a photo of the receipt. The system:

1. Persists the transaction instantly (DynamoDB).
2. Recomputes each member's net balance on demand (Lambda), including a
   debt-simplification step that proposes the minimum number of payments
   needed to settle the group.
3. Feeds every transaction into a serverless analytics pipeline
   (DynamoDB Streams → S3 → Glue → Athena) so members can see spending
   broken down by category and by month.

### 3.3 Beneficiaries

- **Roommates / shared households** splitting rent and utilities.
- **Friend groups** splitting trip or event costs.
- **Small informal clubs/teams** tracking shared purchases.

## 4. Related work

- **Splitwise** — the dominant commercial expense-splitting app; SplitEase
  reproduces its core "who owes whom" mechanic but as an educational,
  fully-serverless AWS implementation with its own analytics pipeline.
  [Add IEEE-style citation]
- **Tricount** — similar group-expense tracker with multi-currency support.
  [Add IEEE-style citation]
- [Add any academic/technical references you drew on, e.g. AWS
  well-architected guidance for serverless data lakes.]

## 5. System Architecture

### 5.0 Design decisions and constraints

The application was deployed on an **AWS Academy Learner Lab** account,
which imposes two constraints on an otherwise standard serverless design:

- **No new IAM roles.** The lab account denies `iam:CreateRole`, which is
  what AWS SAM/CloudFormation normally does automatically for each Lambda
  function. Every Lambda function's execution role is instead set explicitly
  to the account's pre-provisioned `LabRole` (confirmed via
  `aws iam simulate-principal-policy` that `iam:PassRole` is allowed
  specifically for that role ARN).
- **CloudFront is denied.** Both `cloudfront:CreateDistribution` and
  `cloudfront:CreateOriginAccessControl` return `AccessDenied` for this
  account. The frontend is therefore served via **S3 Static Website
  Hosting** (a public bucket with `WebsiteConfiguration`) rather than a
  CloudFront distribution in front of a private bucket. This was verified
  before implementation via `iam simulate-principal-policy` rather than by
  trial-and-error `sam deploy` failures.

These are documented here because they are lab-account artifacts, not
architectural choices — on a full AWS account, CloudFront + a private site
bucket + auto-generated least-privilege IAM roles per function is the
better-practice configuration, and is a drop-in template change.

**Why no Containers (ECS/Fargate).** This is a deliberate choice, not a lab
constraint. Every operation in this app (create a group, add a transaction,
compute a balance) is a short, stateless, independent request triggered by
one user action — there is no long-running process, background worker, or
custom OS-level dependency that would justify a container. Containers earn
their cost when a workload needs to stay warm to avoid latency on
sustained/predictable traffic, or needs a runtime AWS Lambda can't provide.
Neither applies here: usage per group is bursty and infrequent (a handful of
requests whenever someone logs an expense), so paying to keep an ECS/Fargate
task running — or managing its scaling — would be strictly worse than
Lambda's scale-to-zero, pay-per-invocation model for this access pattern.

### 5.1 Architecture diagram

> Replace this section with an exported PNG/SVG (place it in
> `doc_images/architecture.png` and reference it here). A Mermaid source you
> can render (e.g. in the Mermaid Live Editor or VS Code) is included below
> as a starting point — extend it to show every request/response and
> event-trigger arrow explicitly, per the brief's requirement to show 1) the
> whole process from each client operation, 2) detailed interactions between
> every component, and 3) each component's function.

```mermaid
flowchart TD
    User[Browser: SPA] -->|HTTP, S3 static website hosting| S3Site[S3: static site bucket]

    User -->|Sign up / sign in / change password (SRP)| Cognito[Cognito User Pool]
    User -->|fetch + Bearer JWT| APIGW[API Gateway HTTP API<br/>Cognito JWT authorizer]

    Cognito -->|Post Confirmation trigger| LPostConfirm[Lambda: post_confirmation]
    LPostConfirm --> UsersDDB[(DynamoDB: UsersTable)]
    APIGW --> LAccount[Lambda: account]
    LAccount --> UsersDDB

    APIGW --> LGroups[Lambda: groups]
    APIGW --> LMembers[Lambda: members]
    APIGW --> LTxn[Lambda: transactions]
    APIGW --> LBalances[Lambda: balances]
    APIGW --> LReceipt[Lambda: receipts_upload_url]
    APIGW --> LReports[Lambda: reports]

    LGroups --> DDB[(DynamoDB: single table)]
    LMembers --> DDB
    LTxn --> DDB
    LBalances --> DDB
    LReceipt -->|presigned URL| S3Receipts[S3: receipts bucket]
    User -->|PUT image| S3Receipts

    DDB -->|Streams: INSERT TXN| LExport[Lambda: stream_export]
    LExport --> S3Analytics[S3: analytics bucket]
    S3Analytics --- Glue[Glue Data Catalog: transactions table]
    LReports -->|SQL query| Athena[Athena]
    Athena --> Glue
    Athena --> S3Analytics
```

### 5.2 System description

| Component | Purpose |
|---|---|
| **Amazon S3 (site bucket)** | Hosts the static SPA (HTML/CSS/JS) via S3 Static Website Hosting. Chosen for zero-server, pay-per-use hosting of static assets (CloudFront was the original plan for this layer but is denied on the lab account — see §5.0). |
| **Amazon Cognito** | Manages user sign-up/sign-in and issues JWTs; keeps each user's groups scoped to their identity without building custom auth. |
| **Amazon API Gateway (HTTP API)** | Exposes REST-style endpoints (`/groups`, `/groups/{id}/transactions`, etc.), validates the Cognito JWT on every call, and routes to the correct Lambda. |
| **AWS Lambda** | Seven functions implement all business logic: group/member management, transaction recording, on-demand balance + debt-simplification calculation, receipt-upload URL generation, DynamoDB-Streams export, and Athena-backed reporting. Chosen over a server-based approach (EC2/Elastic Beanstalk) because workload is bursty/low-volume per user and benefits from scale-to-zero pricing. |
| **Amazon DynamoDB** (`ExpenseTable`) | Single-table NoSQL store for groups, members, and transactions. Chosen for low-latency reads/writes at any scale and native Streams support, which powers the analytics pipeline without a separate ETL job. Balances are **not** stored as a field — they are computed on demand from the full transaction history each time `/balances` is called, so they can never drift out of sync with the underlying transactions. |
| **Amazon DynamoDB** (`UsersTable`) | A **separate** table holding a simple user profile row per account (`email`, `username`, `password_last_changed_at`). Auto-populated by the `post_confirmation` Lambda right after sign-up, and touched again by `account` after a password change. See §5.3.1 for why its `password` column never holds a real credential. |
| **Amazon S3 (receipts bucket)** | Stores user-uploaded receipt images. The frontend uploads directly via a Lambda-issued presigned URL, so image bytes never pass through API Gateway/Lambda. |
| **Amazon S3 (analytics bucket)** | Data-lake landing zone for exported transaction records (JSON) and Athena query results. |
| **AWS Glue Data Catalog** | Defines the schema over the analytics bucket's JSON files so Athena can query it as a table without a separate database server. |
| **Amazon Athena** | Serverless SQL queries over the data lake to produce "spending by category" and "spending by month" reports, rendered as charts in the UI. Covers the "Analytics" requirement / Big Data analysis learning outcome. |

### 5.2.1 Lambda function breakdown

Nine Lambda functions each own one narrow responsibility. All API-triggered
ones sit behind the same API Gateway HTTP API with the Cognito JWT
authorizer; `stream_export` has no HTTP endpoint at all (invoked directly by
DynamoDB), and `post_confirmation` has no HTTP endpoint either (invoked
directly by Cognito).

| Function | Trigger | Purpose | AWS services it talks to |
|---|---|---|---|
| `groups` | API Gateway: `POST/GET/PUT/DELETE /groups`, `GET/PUT/DELETE /groups/{groupId}` | Create, list, view, rename, and delete groups | DynamoDB (read/write `GROUP#`/`USER#` items); reads the caller's identity from the Cognito claims API Gateway injects |
| `members` | API Gateway: `POST/PUT/DELETE /groups/{groupId}/members` | Add, rename, or remove a member; rename cascades to that member's name on every existing transaction | DynamoDB (read/write group + transaction items) |
| `transactions` | API Gateway: `POST/GET/PUT/DELETE /groups/{groupId}/transactions[/{txnId}]` | Record, list, edit, and delete individual expense transactions; automatically converts a transaction's amount into the group's base currency via a third-party exchange-rate API when they differ | DynamoDB (writes here are what DynamoDB Streams picks up for the analytics pipeline); **Open Exchange Rate API** (third-party, external to AWS) |
| `balances` | API Gateway: `GET /groups/{groupId}/balances` | Compute each member's net balance and the minimal-transaction debt settlement, fresh on every call | DynamoDB (read-only) |
| `receipts_upload_url` | API Gateway: `POST /receipts/upload-url`, `GET /receipts/view-url` | Issue short-lived presigned S3 URLs so the browser can upload/view a receipt image directly, without the bytes passing through Lambda | S3 (receipts bucket) |
| `stream_export` | **DynamoDB Streams** (not an HTTP route) — fires on every transaction insert/edit/delete | Mirror each transaction into the S3 data lake as a JSON file (or delete it, on removal), keeping the analytics copy in sync with the live data | DynamoDB Streams (event source), S3 (analytics bucket) |
| `reports` | API Gateway: `GET /groups/{groupId}/reports` | Run two Athena SQL queries (spend by category, spend by month) filtered to one group and return the rows as JSON | Athena (query execution), Glue Data Catalog (schema lookup via the Athena database reference), S3 (analytics bucket — both the query source and the results location) |
| `post_confirmation` | **Cognito Post Confirmation trigger** (not an HTTP route) — fires right after a user confirms sign-up | Auto-create that user's row in `UsersTable` (username, email) | DynamoDB (`UsersTable`) |
| `account` | API Gateway: `PUT /account/password-changed` | Called by the frontend immediately after Cognito confirms a password change, to timestamp it on the user's profile row | DynamoDB (`UsersTable`) |

### 5.2.2 Third-party API integration

**Open Exchange Rate API** (`open.er-api.com`) — a free, keyless REST API
external to AWS — powers multi-currency expense splitting:

- Each group has a **base currency** (chosen at creation, defaults to USD).
  Balances, settlements, and Athena reports are always computed in this one
  currency so they stay comparable and summable.
- When a member logs a transaction in a *different* currency (e.g. a group
  based in USD logging a "120 EUR" dinner), the `transactions` Lambda
  automatically calls `GET https://open.er-api.com/v6/latest/{currency}`,
  reads the exchange rate to the base currency, and stores **both** the
  original amount/currency (for display) and the converted amount (used for
  every downstream calculation).
- This call is fully automatic — the user never sees or triggers it
  directly. It happens identically on `POST /transactions` (create) and
  `PUT /transactions/{txnId}` (edit). If the third-party API is unreachable,
  the Lambda falls back to a 1:1 rate rather than failing the request, so a
  transient outage on their side never blocks a user from recording an
  expense.
- The frontend shows both figures on a transaction card when they differ,
  e.g. *"Alice paid 120.00 EUR (≈ 130.44 USD)"*.

### 5.2.3 Settling up (partial or full payment)

The Balances tab doesn't just report who owes whom — it lets a member
record that a real payment happened. Each suggested settlement has a
"Settle up" button pre-filled with the full amount owed, which the user can
lower to record a **partial** payment instead. Confirming it calls the same
`POST /transactions` endpoint with `is_settlement: true` and a `payee`
field instead of a split: `transactions` stores it as a direct payer→payee
transfer (no split across the group), and `compute_balances` treats it as
moving balance one-for-one between exactly those two members rather than
dividing it. This means settling up is not a separate ledger bolted onto
the side — it's the same transaction stream everything else already reads
(balances, Athena reports, the DynamoDB Streams export), so it stays
consistent automatically rather than needing special-cased sync logic.

### 5.2.4 Balance calculation algorithm

**Triggered by exactly one API**: `GET /groups/{groupId}/balances`, handled
by the `balances` Lambda. That function itself is thin — it authenticates
the caller, queries every transaction for the group from DynamoDB, and
delegates the actual arithmetic to two functions imported from the shared
Lambda Layer (`backend/layers/common/python/split.py`), not code local to
the `balances` function. Every Lambda has this layer attached, but only
`balances` currently calls into `split.py`.

**`compute_balances(transactions, member_ids)`** — one pass over every
transaction, branching on whether it's a shared expense or a settlement:

- **Shared expense**: `share = amount / len(split_among)` (divide), then the
  payer's balance is *increased* by the full `amount` (add) and every
  member in `split_among` — including the payer, since they also consumed
  a share — has their balance *decreased* by `share` (subtract).
  Example: Alice pays $100, split across Alice/Bob/Carol → `share = 33.33`;
  Alice: `0 + 100 − 33.33 = +66.67`; Bob: `0 − 33.33 = −33.33`; Carol the
  same. The three balances always sum to zero — that invariant is how the
  formula is sanity-checked.
- **Settlement** (`is_settlement=true`): no division — it's a direct 1:1
  transfer, so the payer's balance is increased by `amount` and the
  payee's is decreased by `amount`, moving balance between exactly those
  two members instead of splitting it.

All results are rounded to 2 decimal places at the end.

**`simplify_debts(balances)`** — a separate, greedy algorithm that turns
the raw per-member balances into the minimum number of payments needed to
settle the whole group: sort members into creditors (balance > 0) and
debtors (balance < 0), repeatedly match the largest debtor against the
largest creditor for `min(their two amounts)`, and advance whichever side
hits zero first. This is why a group of 5 people with messy cross-debts can
collapse into 2-3 suggested payments instead of everyone paying everyone.

Because both functions run fresh on every single call — nothing is cached
or pre-computed — balances can never drift out of sync with the underlying
transactions (see §5.2 for why nothing is stored instead).

### 5.3 Data structures / API

**DynamoDB single-table design** (`PK`, `SK`):

| PK | SK | Represents |
|---|---|---|
| `GROUP#<id>` | `METADATA` | Group name, creator, member list |
| `GROUP#<id>` | `TXN#<timestamp>#<txnId>` | One expense transaction |
| `USER#<userId>` | `GROUP#<id>` | Membership index for "list my groups" |

**Why one table, not separate `Groups`/`Transactions` tables — and the
trade-off.** This is DynamoDB's recommended "single-table design" pattern:
model the table around the queries you actually run, not around each
entity. The concrete win here is that fetching a group's detail screen
(metadata + every transaction) is **one** `Query` on `PK = GROUP#<id>` — a
two-table design would need a second `Query` (via a GSI on `group_id` in a
separate `Transactions` table) to get the same result, roughly doubling that
request's latency. Cost is *not* a real factor either way — on-demand
billing charges per request regardless of table count, and DynamoDB also
supports transactions across multiple tables, so "needs one table for
atomic writes" is not a valid argument for it.

The honest trade-off: a single table is harder to eyeball in the console —
scanning it returns `METADATA`, `TXN`, and `USER_GROUP` items interleaved,
distinguishable only by their `type` attribute and key shape — and it's
less natural for a team unfamiliar with the pattern (used to designing
tables around entities first, then joining). A two-table design would have
been an equally valid choice for this project's small, fixed set of access
patterns, just marginally slower for the one query that matters most.

### 5.3.1 `UsersTable` and why `password` is never a real value

A separate table (not part of the single-table design above, by request)
holds one profile row per account, keyed by `email`:

| Attribute | Meaning |
|---|---|
| `email` (key) | The account's email / Cognito username |
| `username` | Auto-derived from the email's local part (e.g. `alice` from `alice@example.com`) |
| `password` | **Always** the fixed string `"(managed by AWS Cognito - not stored here)"` — see below |
| `password_last_changed_at` | Unix timestamp, updated when the password is changed |
| `cognito_sub` | The user's Cognito subject ID, for cross-reference |

**Why `password` can never hold a real value — this is a hard constraint,
not a shortcut.** Cognito stores passwords as a one-way hash; it is
cryptographically impossible for anyone, including AWS, to retrieve a
user's actual password back out of Cognito. There was never a real
password available to copy into this table. The **Change Password**
feature (`Auth.changePassword` in `frontend/js/auth.js`) reflects this: the
old and new password are sent directly from the browser to Cognito over
SRP (`CognitoUser.changePassword`) and verified/updated entirely inside
Cognito — this application's own backend (API Gateway, Lambda) never
receives either value. The `account` Lambda is only called *after* Cognito
confirms success, purely to stamp `password_last_changed_at`; a `password`
row is therefore both unnecessary and unsafe to include for real, so it is
kept as an inert placeholder that documents *why* it's empty rather than
silently omitting the column.

**Referential integrity across items.** DynamoDB has no foreign keys, joins, or
triggers, so every place the same fact is duplicated across items has to be
kept in sync explicitly by the Lambda handling the write:

- **Renaming a group** updates `name` on the `METADATA` item, `group_name` on
  the creator's `USER#<id>/GROUP#<id>` index item, *and* the `group_name`
  copy embedded in every `TXN#...` item under that group (used for
  display/export) — three writes for one logical rename.
- **Renaming a member** updates the `members` list on `METADATA`, then
  rewrites `payer`/`split_among` on every transaction that referenced the old
  name, so balances and reports never see a stale member name.
- **Removing a member** is rejected (400) if any transaction still
  references them as `payer` or in `split_among`, to avoid orphaning a
  transaction's split.
- **Deleting a group** deletes every item under its `GROUP#<id>` partition
  (metadata + all transactions) plus the creator's `USER#<id>` index entry,
  in one batched write — no leftover rows.

This was verified end-to-end against the live deployment (not just read from
the code): create a group → add a transaction → rename the group → rename a
member → confirm the transaction, balances, and the S3/Athena analytics
export all reflect the new names → delete the group → confirm zero rows
remain in DynamoDB for that group.

**Transaction record (also exported to the analytics data lake).**
`amount` is always in the group's base currency (used by balances/reports);
`original_amount`/`currency`/`exchange_rate` record what the user actually
entered and the rate the third-party API returned, purely for display:

```json
{
  "txn_id": "uuid",
  "group_id": "uuid",
  "payer": "Alice",
  "amount": 32.50,
  "currency": "EUR",
  "original_amount": 30.00,
  "exchange_rate": 1.0833,
  "description": "Groceries",
  "category": "Groceries",
  "split_among": ["Alice", "Bob", "Carol"],
  "receipt_key": "receipts/<group>/<uuid>.jpg",
  "created_at": "2026-08-11T04:00:00Z"
}
```

**Key REST endpoints** (all require `Authorization: <Cognito ID token>`):

| Method | Path | Description |
|---|---|---|
| POST | `/groups` | Create a group |
| GET | `/groups` | List the caller's groups |
| GET | `/groups/{groupId}` | Group details + members |
| PUT | `/groups/{groupId}` | Rename a group (creator only) |
| DELETE | `/groups/{groupId}` | Delete a group and all its transactions (creator only) |
| POST | `/groups/{groupId}/members` | Add a member |
| PUT | `/groups/{groupId}/members` | Rename a member (cascades to their transactions) |
| DELETE | `/groups/{groupId}/members` | Remove a member (rejected if referenced by a transaction) |
| POST | `/groups/{groupId}/transactions` | Record a transaction |
| GET | `/groups/{groupId}/transactions` | List transactions |
| PUT | `/groups/{groupId}/transactions/{txnId}` | Edit a transaction |
| DELETE | `/groups/{groupId}/transactions/{txnId}` | Delete a transaction |
| GET | `/groups/{groupId}/balances` | Net balances + suggested settlements |
| POST | `/receipts/upload-url` | Get a presigned S3 PUT URL to upload a receipt |
| GET | `/receipts/view-url?key=...` | Get a presigned S3 GET URL to view a receipt |
| GET | `/groups/{groupId}/reports` | Athena-backed category/month spend breakdown |
| PUT | `/account/password-changed` | Timestamp a successful password change on the caller's `UsersTable` row |

### 5.3.4 DynamoDB tables field reference (demo cheat sheet)

**Note on column order.** DynamoDB is a schemaless NoSQL store, not a SQL
table — it does not preserve or guarantee any particular attribute order.
Verified directly: writing an item with attributes in one order and reading
it back returned them in a different order entirely (confirmed via
`put-item`/`get-item` with deliberately mis-ordered test fields). The tables
below present attributes in a fixed **logical** order for readability in
this document — the AWS Console or `get-item` may display them differently,
and that is expected, not a bug.

#### Table 1 — `ExpenseTable` (the main single-table store)

**Item type: `METADATA`** (one per group)

| Column | Meaning | Set/updated by | How to delete |
|---|---|---|---|
| `PK` | `GROUP#<group_id>` — never changes after creation | `POST /groups` | Only by deleting the whole item (`DELETE /groups/{id}`) |
| `SK` | Fixed literal `"METADATA"` | `POST /groups` | Same as above |
| `type` | Always `"GROUP"` — lets a `Scan`/`Query` tell this item apart from `TXN`/`USER_GROUP` items sharing the same `PK` | Set once, never changes | n/a |
| `group_id` | Same UUID as in `PK`, duplicated as a plain attribute so API responses don't need to parse it back out of the key | Set once | n/a |
| `name` | The group's display name | `POST /groups` (create) / `PUT /groups/{id}` (rename — also cascades into `USER_GROUP.group_name` and every `TXN.group_name`) | n/a (delete the group) |
| `created_by` | Email of the Cognito user who created the group — the only account allowed to rename/delete it | Set once at creation, never changes | n/a |
| `created_at` | Unix timestamp of group creation | Set once | n/a |
| `members` | List of member name strings (free text, not necessarily real accounts) | `POST /groups/{id}/members`, `PUT .../members` (rename), `DELETE .../members` (remove) | Removing a name from this list is the "delete", there's no separate member item |
| `base_currency` | e.g. `"USD"`, `"VND"` — every transaction's `amount` is normalized to this currency | Set once at group creation | n/a |

**Item type: `TXN#<timestamp>#<txn_id>`** (one per transaction *and* per settlement — same shape)

| Column | Meaning | Set/updated by | How to delete |
|---|---|---|---|
| `PK` | `GROUP#<group_id>` this transaction belongs to — never changes | `POST /transactions` | `DELETE /transactions/{txnId}` removes the whole item |
| `SK` | `TXN#<real insertion timestamp>#<txn_id>` — the timestamp here is **always the real wall-clock time of creation**, independent of the user-chosen expense date (verified: backdating to `2020-01-01` did not change the SK's embedded timestamp) | Set once at creation, never changes (even on edit — `update_transaction` always targets the original `PK`/`SK`) | Same as above |
| `type` | Always `"TXN"` | Set once | n/a |
| `txn_id` | UUID, duplicated as a plain attribute (also embedded in `SK`) | Set once | n/a |
| `group_id` | Duplicated from `PK` for convenience | Set once | n/a |
| `group_name` | Denormalized copy of the group's name at write time | Set at creation; re-synced on every group rename (see §5.3 referential-integrity notes) | n/a |
| `payer` | Who paid | `POST`/`PUT /transactions` | n/a |
| `payee` | Only set for settlements (`is_settlement=true`) — who received the payment | Same | n/a |
| `is_settlement` | `true` = a payer→payee debt settlement (no split); `false`/absent = a normal shared expense | Same | n/a |
| `amount` | Transaction amount **converted into the group's `base_currency`** — this is the value balances/reports actually use | Same (auto-computed via the exchange-rate API when `currency` differs from `base_currency`) | n/a |
| `original_amount` | The amount as the user actually typed it, in `currency` | Same | n/a |
| `currency` | The currency the user entered the amount in | Same | n/a |
| `exchange_rate` | Rate applied to get `amount` from `original_amount`; `1.0` if same currency | Same | n/a |
| `category` | Expense category, or the fixed literal `"Settlement"` for settlements | Same | n/a |
| `split_among` | List of members sharing this expense; empty list `[]` for a settlement | Same | n/a |
| `description` | Free-text note | Same | n/a |
| `receipt_key` | S3 object key for an uploaded receipt image, or `null` | Same (also auto-deletes the old S3 object if replaced — see §5.2) | Deleting the transaction, or replacing the receipt, deletes the S3 object too |
| `created_at` | **User-editable "expense date"**, independent of `SK`'s real-insertion timestamp — this is what the UI sorts/displays by | `POST`/`PUT /transactions` (optional `date` field; defaults to "now" if omitted) | n/a |

**Item type: `USER_GROUP`** (index row — lets a Cognito account see "their" groups)

| Column | Meaning | Set/updated by | How to delete |
|---|---|---|---|
| `PK` | `USER#<email>` of the linked account | Auto-created whenever that exact email appears as a group creator or as a member (see §5.3, referential integrity) | Automatically when the member is removed/renamed away, or the group is deleted |
| `SK` | `GROUP#<group_id>` | Set once | Same as above |
| `type` | Always `"USER_GROUP"` | Set once | n/a |
| `group_id` | Duplicated for convenience | Set once | n/a |
| `group_name` | Denormalized copy, kept in sync on group rename | Re-synced on `PUT /groups/{id}` | n/a |

#### Table 2 — `UsersTable` (separate table, one row per account)

| Column | Meaning | Set/updated by | How to delete |
|---|---|---|---|
| `email` (partition key) | The account's email / Cognito username | `post_confirmation` Lambda, right after sign-up | Deleting the row (no UI for this - would need direct DynamoDB access) |
| `username` | Auto-derived from the email's local part (e.g. `alice` from `alice@example.com`) | Same, self-heals via `if_not_exists` if the row was missing | n/a |
| `password` | **Always** the fixed placeholder `"(managed by AWS Cognito - not stored here)"` — never a real credential (see §5.3.1) | Never changes | n/a |
| `password_last_changed_at` | Unix timestamp of the last successful password change | `account` Lambda, called right after Cognito confirms `changePassword` succeeded | n/a |
| `cognito_sub` | The account's Cognito subject ID, for cross-reference | `post_confirmation` Lambda | n/a |

## 6. References

Use IEEE style. Examples to adapt:

[1] Amazon Web Services, "AWS Serverless Application Model (SAM) Developer Guide," 2026. [Online]. Available: https://docs.aws.amazon.com/serverless-application-model/
[2] Amazon Web Services, "Amazon Cognito Developer Guide," 2026. [Online]. Available: https://docs.aws.amazon.com/cognito/
[3] Amazon Web Services, "Amazon Athena User Guide," 2026. [Online]. Available: https://docs.aws.amazon.com/athena/
[4] ExchangeRate-API, "Open Exchange Rate API documentation," 2026. [Online]. Available: https://www.exchangerate-api.com/docs/free
[5] [Add every tutorial/Stack Overflow/blog post you actually used while building.]
