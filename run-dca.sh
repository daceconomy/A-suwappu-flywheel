#!/bin/bash
# SECURITY: Never commit .env to git. Copy from .env.example and fill in values.
# Verify: grep -r "SUWAPPU_API_KEY=suwappu_sk_" . --include="*.sh" --include="*.env"
export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

FLYWHEEL_DIR="$HOME/Desktop/suwappu-flywheel"
cd "$FLYWHEEL_DIR" || exit 1

# Load env vars
if [ ! -f "$FLYWHEEL_DIR/.env" ]; then echo "ERROR: .env not found. Copy .env.example first."; exit 1; fi
set -a; source "$FLYWHEEL_DIR/.env"; set +a

# Run full flywheel: DCA buy + Grid sell + Brain learn
echo "$(date): starting flywheel run" >> ~/.suwappu-flywheel/cron.log
bun run src/cli.ts run --execute --amount 2 --json 2>&1 | tee -a ~/.suwappu-flywheel/flywheel.log

# Log result
echo "$(date): flywheel run completed (exit $?)" >> ~/.suwappu-flywheel/cron.log
