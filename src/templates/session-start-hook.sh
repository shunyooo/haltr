#!/bin/bash
# haltr SessionStart hook
# Sets HALTR_SESSION_ID for session-scoped task resolution
SESSION_ID=$(cat | jq -r '.session_id // empty')
if [ -n "$SESSION_ID" ] && [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "export HALTR_SESSION_ID=$SESSION_ID" >> "$CLAUDE_ENV_FILE"
fi
exit 0
