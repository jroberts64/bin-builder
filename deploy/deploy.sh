#!/usr/bin/env bash
# Build and deploy the static site to S3 + CloudFront.
#
#   ./deploy/deploy.sh
#
# Reads stack outputs from CloudFormation, so it never hard-codes bucket or
# distribution ids. Requires an active SSO session (run: aws sso login
# --sso-session personal-sso).
set -euo pipefail

PROFILE="${AWS_PROFILE:-personal-sso}"
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-bin-builder-site}"

cd "$(dirname "$0")/.."

echo "==> Resolving stack outputs ($STACK)…"
read -r BUCKET DIST <<<"$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'||OutputKey=='DistributionId'].OutputValue" \
  --output text)"
URL="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='SiteURL'].OutputValue" --output text)"

if [[ -z "${BUCKET:-}" || -z "${DIST:-}" ]]; then
  echo "ERROR: could not read stack outputs. Is the stack deployed and SSO logged in?" >&2
  exit 1
fi
echo "    bucket=$BUCKET  distribution=$DIST"

echo "==> Building…"
npm run build

echo "==> Syncing to s3://$BUCKET …"
# Hashed assets get a long immutable cache; index.html is always revalidated so
# new deploys are picked up immediately.
aws s3 sync dist/ "s3://$BUCKET/" --delete \
  --profile "$PROFILE" --region "$REGION" \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "index.html"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --profile "$PROFILE" --region "$REGION" \
  --cache-control "no-cache" --content-type "text/html"

echo "==> Invalidating CloudFront cache…"
aws cloudfront create-invalidation \
  --distribution-id "$DIST" --paths "/*" \
  --profile "$PROFILE" --region "$REGION" \
  --query "Invalidation.Id" --output text

echo "==> Done. Live at: $URL"
