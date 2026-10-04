#!/bin/sh
set -e

# Auto-generate AUTH_SECRET if not provided
if [ -z "$AUTH_SECRET" ]; then
  export AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  echo "AUTH_SECRET was not set — generated a temporary secret for this container."
fi

# Run migrations as root (before switching users)
npx -y prisma@6.19.0 migrate deploy

# Automatic fresh-native activation for this container's DATABASE_URL.
# The bootstrap accepts no database-path argument. An ineligible database
# is left unchanged; a failed activation exits non-zero and blocks startup.
node /app/fresh-native-runtime/ensure-fresh-native.cjs

# Fix /data permissions and run app as nextjs user
chown -R nextjs:nodejs /data
export HOME=/home/nextjs
exec su -s /bin/sh nextjs -c "HOSTNAME=0.0.0.0 PORT=${PORT:-3737} node server.js"
