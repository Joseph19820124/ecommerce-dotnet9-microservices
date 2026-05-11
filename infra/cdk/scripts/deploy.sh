#!/usr/bin/env bash
# =============================================================================
# ECommerce CDK Deployment Script
# =============================================================================
# Usage:
#   ./scripts/deploy.sh [dev|staging|prod]
#
# Requirements:
#   - AWS CLI v2 configured with credentials that have CDK/CloudFormation access
#   - Node.js >= 18
#   - npm >= 9
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'   # No Colour

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DEPLOY_ENV="${1:-dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_STACK="ECommerceInfraStack"
SERVICES_STACK="ECommerceServicesStack"

info "Target environment : ${DEPLOY_ENV}"
info "CDK directory       : ${CDK_DIR}"

# ---------------------------------------------------------------------------
# 1. Pre-flight checks
# ---------------------------------------------------------------------------
info "--- Step 1: Pre-flight checks ---"

command -v aws    >/dev/null 2>&1 || error "AWS CLI not found. Install from https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
command -v node   >/dev/null 2>&1 || error "Node.js not found. Install from https://nodejs.org"
command -v npm    >/dev/null 2>&1 || error "npm not found."
command -v npx    >/dev/null 2>&1 || error "npx not found."

# Check AWS identity
AWS_IDENTITY=$(aws sts get-caller-identity 2>/dev/null) || error "AWS CLI is not configured or credentials are invalid. Run 'aws configure'."
AWS_ACCOUNT=$(echo "${AWS_IDENTITY}" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)
AWS_REGION="${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo 'us-east-1')}"
AWS_USER=$(echo "${AWS_IDENTITY}" | grep -o '"Arn": "[^"]*"' | cut -d'"' -f4)

success "AWS CLI configured"
info "  Account : ${AWS_ACCOUNT}"
info "  Region  : ${AWS_REGION}"
info "  Identity: ${AWS_USER}"

# Validate environment argument
case "${DEPLOY_ENV}" in
  dev|staging|prod) ;;
  *) error "Invalid environment '${DEPLOY_ENV}'. Must be dev, staging, or prod." ;;
esac

# Warn before prod deployments
if [[ "${DEPLOY_ENV}" == "prod" ]]; then
  warn "You are deploying to PRODUCTION."
  read -r -p "Type 'yes-prod' to continue: " CONFIRM
  [[ "${CONFIRM}" == "yes-prod" ]] || error "Deployment aborted."
fi

# ---------------------------------------------------------------------------
# 2. Install npm dependencies
# ---------------------------------------------------------------------------
info "--- Step 2: Installing npm dependencies ---"
cd "${CDK_DIR}"
npm ci --silent
success "npm dependencies installed"

# ---------------------------------------------------------------------------
# 3. Build TypeScript
# ---------------------------------------------------------------------------
info "--- Step 3: Building TypeScript ---"
npm run build
success "TypeScript compiled successfully"

# ---------------------------------------------------------------------------
# 4. CDK Bootstrap (idempotent — safe to run every time)
# ---------------------------------------------------------------------------
info "--- Step 4: CDK Bootstrap ---"
export CDK_DEFAULT_ACCOUNT="${AWS_ACCOUNT}"
export CDK_DEFAULT_REGION="${AWS_REGION}"
export DEPLOY_ENV="${DEPLOY_ENV}"

npx cdk bootstrap \
  "aws://${AWS_ACCOUNT}/${AWS_REGION}" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
  --require-approval never
success "CDK bootstrap complete"

# ---------------------------------------------------------------------------
# 5. Synthesise (validate) before deploying
# ---------------------------------------------------------------------------
info "--- Step 5: CDK Synth (validation) ---"
npx cdk synth --quiet
success "CDK synth passed — CloudFormation templates are valid"

# ---------------------------------------------------------------------------
# 6. Deploy Infrastructure Stack
# ---------------------------------------------------------------------------
info "--- Step 6: Deploying ${INFRA_STACK} ---"
START_INFRA=$(date +%s)

npx cdk deploy "${INFRA_STACK}" \
  --require-approval never \
  --outputs-file /tmp/infra-outputs.json \
  --progress events

END_INFRA=$(date +%s)
success "${INFRA_STACK} deployed in $(( END_INFRA - START_INFRA ))s"

# ---------------------------------------------------------------------------
# 7. Deploy Services Stack
# ---------------------------------------------------------------------------
info "--- Step 7: Deploying ${SERVICES_STACK} ---"
START_SVC=$(date +%s)

npx cdk deploy "${SERVICES_STACK}" \
  --require-approval never \
  --outputs-file /tmp/services-outputs.json \
  --progress events

END_SVC=$(date +%s)
success "${SERVICES_STACK} deployed in $(( END_SVC - START_SVC ))s"

# ---------------------------------------------------------------------------
# 8. Print endpoint summary
# ---------------------------------------------------------------------------
info "--- Step 8: Endpoint Summary ---"
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ECommerce Platform — Deployment Done  ${NC}"
echo -e "${GREEN}========================================${NC}"

# Parse outputs files if jq is available
if command -v jq >/dev/null 2>&1; then
  ALB_DNS=$(jq -r ".${INFRA_STACK}.AlbDnsName // .${SERVICES_STACK}.AlbDnsName // empty" \
    /tmp/infra-outputs.json /tmp/services-outputs.json 2>/dev/null | head -1)
  DB_ENDPOINT=$(jq -r ".${INFRA_STACK}.DbInstanceEndpoint // empty" /tmp/infra-outputs.json 2>/dev/null)
  REDIS_ENDPOINT=$(jq -r ".${INFRA_STACK}.RedisEndpoint // empty" /tmp/infra-outputs.json 2>/dev/null)
  OS_ENDPOINT=$(jq -r ".${INFRA_STACK}.OpenSearchEndpoint // empty" /tmp/infra-outputs.json 2>/dev/null)
  MQ_ARN=$(jq -r ".${INFRA_STACK}.MqBrokerArn // empty" /tmp/infra-outputs.json 2>/dev/null)
  CLUSTER=$(jq -r ".${INFRA_STACK}.EcsClusterName // empty" /tmp/infra-outputs.json 2>/dev/null)

  echo ""
  echo -e "  ${CYAN}API Gateway URL   :${NC} http://${ALB_DNS:-<check-cfn-outputs>}"
  echo -e "  ${CYAN}ALB DNS           :${NC} ${ALB_DNS:-<check-cfn-outputs>}"
  echo -e "  ${CYAN}RDS Endpoint      :${NC} ${DB_ENDPOINT:-<check-cfn-outputs>}"
  echo -e "  ${CYAN}Redis Endpoint    :${NC} ${REDIS_ENDPOINT:-<check-cfn-outputs>}"
  echo -e "  ${CYAN}OpenSearch URL    :${NC} https://${OS_ENDPOINT:-<check-cfn-outputs>}"
  echo -e "  ${CYAN}MQ Broker ARN     :${NC} ${MQ_ARN:-<check-cfn-outputs>}"
  echo -e "  ${CYAN}ECS Cluster       :${NC} ${CLUSTER:-<check-cfn-outputs>}"
  echo ""
  echo -e "  ${YELLOW}NOTE:${NC} RDS databases must be initialised manually:"
  echo -e "        aws cloudformation describe-stacks \\"
  echo -e "          --stack-name ecommerce-${DEPLOY_ENV}-infra \\"
  echo -e "          --query \"Stacks[0].Outputs[?OutputKey=='DbInitSql'].OutputValue\" \\"
  echo -e "          --output text"
else
  warn "jq not found — printing raw output files:"
  cat /tmp/infra-outputs.json 2>/dev/null || true
  cat /tmp/services-outputs.json 2>/dev/null || true
fi

echo ""
info "Outputs saved to /tmp/infra-outputs.json and /tmp/services-outputs.json"
echo ""
success "All done! Environment: ${DEPLOY_ENV}"
