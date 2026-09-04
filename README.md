# SplitEase — Group Expense Splitter (RMIT Cloud Computing, Assessment 3)

A serverless AWS application that lets groups of friends/roommates create
expense groups, log shared transactions (with optional receipt photos),
see real-time balances ("who owes whom"), and view spending analytics.

## Architecture at a glance

```
Browser (Cognito login)
   │
   ▼
S3 (static site bucket, Static Website Hosting)
   │
   ▼  (fetch, Bearer JWT)
API Gateway (HTTP API, Cognito JWT authorizer)
   │
   ├── /groups, /groups/{id}                → Lambda: groups
   ├── /groups/{id}/members                 → Lambda: members
   ├── /groups/{id}/transactions            → Lambda: transactions
   ├── /groups/{id}/balances                → Lambda: balances
   ├── /receipts/upload-url                 → Lambda: receipts_upload_url ──► S3 (receipts bucket)
   └── /groups/{id}/reports                 → Lambda: reports ──► Athena ──► Glue Catalog ──► S3 (analytics bucket)
                                                                                     ▲
DynamoDB (single table) ──── Streams ──► Lambda: stream_export ────────────────────┘
```

| AWS service | Category | How it's used |
|---|---|---|
| AWS Lambda | Compute | 7 functions implement all business logic |
| API Gateway (HTTP API) | Compute | REST-style API, Cognito JWT authorizer |
| Amazon DynamoDB | Database | Single-table store for groups/members/transactions, Streams enabled |
| Amazon S3 | Storage | Static site bucket (Static Website Hosting), receipts bucket, analytics data-lake bucket |
| Amazon Athena + AWS Glue Data Catalog | Analytics | Ad-hoc SQL over exported transaction data for spending reports |
| Amazon Cognito | Security (not separately scored) | User sign-up/sign-in, issues JWTs consumed by API Gateway |

> **Note on CloudFront:** the original design put CloudFront in front of the
> site bucket to cover the "Networking and Content Delivery" category. This
> stack is deployed on an **AWS Academy Learner Lab** account, which denies
> `cloudfront:CreateDistribution` and `cloudfront:CreateOriginAccessControl`
> outright (confirmed via `iam simulate-principal-policy`). The frontend is
> served instead via **S3 Static Website Hosting** (a public bucket with
> `WebsiteConfiguration`). If you deploy this on a full AWS account later,
> reintroducing CloudFront is a drop-in template change — see git history /
> ask for the CloudFront version of `template.yaml`.

See `docs/Solution_Architecture_Document.md` for the full write-up required
by the assignment brief (motivation, related work, architecture diagram,
data structures, references).

## Repository layout

```
template.yaml              SAM template - defines every AWS resource
samconfig.toml             Default `sam deploy` parameters (edit region/stack name)
backend/
  layers/common/python/    Shared helper code, packaged as a Lambda Layer
  functions/<name>/app.py  One Lambda per business capability
frontend/                  Static site (vanilla HTML/CSS/JS + Chart.js + Cognito SDK)
scripts/deploy.sh          Build, deploy, and publish the frontend in one command
docs/                      Solution architecture document + diagram images
```

## Prerequisites

- AWS account with console/CLI access, credentials configured (`aws configure`)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Python 3.12
- `jq` not required; the deploy script uses `python3` for JSON parsing

**If deploying on an AWS Academy Learner Lab account:** the lab role only
allows `us-east-1`, and forbids creating new IAM roles or using CloudFront.
`template.yaml` already accounts for this — every Lambda's execution role is
the account's pre-existing `LabRole` (via the `LabRoleArn` parameter,
defaulted to this project's lab account ARN — override it with
`--parameter-overrides LabRoleArn=arn:aws:iam::<your-account>:role/LabRole`
if deploying under a different Academy account), and the frontend is served
via S3 Static Website Hosting instead of CloudFront.

## Deploy

```bash
git clone <your-repo-url>
cd ASM3_s4124370

# First-time only: pick a region/stack name interactively and save it
sam build
sam deploy --guided

# Every deploy after that (build, deploy stack, publish frontend):
./scripts/deploy.sh
```

`scripts/deploy.sh` reads the CloudFormation stack outputs (API URL, Cognito
User Pool/Client IDs, bucket names, S3 website URL) and writes them into
`frontend/js/config.js` automatically — no manual copy/paste.

After the first deploy, open the printed site URL, sign up with an
email/password (Cognito sends a verification code to that email by default),
confirm the account, then sign in.

## How the analytics pipeline works

1. Every new transaction is written to DynamoDB.
2. DynamoDB Streams triggers the `stream_export` Lambda, which writes a JSON
   copy of the transaction into `s3://<analytics-bucket>/transactions/`.
3. A Glue Data Catalog table (`transactions`) describes that S3 location's
   schema so Athena can query it with plain SQL.
4. The `reports` Lambda runs two Athena queries (spend by category, spend by
   month) filtered to the selected group and returns the rows as JSON.
5. The frontend renders those rows with Chart.js.

Because Athena needs at least one exported record to see, add a transaction
before hitting "Refresh analytics" for the first time.

## Cleanup

```bash
aws s3 rm s3://<site-bucket> --recursive
aws s3 rm s3://<receipts-bucket> --recursive
aws s3 rm s3://<analytics-bucket> --recursive
sam delete --stack-name expense-splitter
```

(S3 buckets must be emptied before `sam delete`/CloudFormation can remove them.)
