#!/usr/bin/env bash
# With/without A/B (and optional interactive) eval for a codegraph version on a
# repo. Codegraph is the ONLY variable: both arms launch claude with
# --strict-mcp-config — with = codegraph-only MCP (pointed at $CG_BIN),
# without = empty MCP. Built-in Read/Grep/Bash stay available in both arms.
#
# Usage: run-all.sh <repo-path> "<question>" [headless|tmux|all]
#
# MULTI-TURN: separate questions with "||" to run them as ONE session —
#   run-all.sh <repo> "How does X work?||Where is Y handled in that path?"
# Turn 1 runs normally; every later turn `--resume`s the same session, so the
# earlier turns' tool output is still in the window (that is the whole point:
# residual context occupancy, the cost a single-question run cannot see).
# Segments land in run-<label>.jsonl, run-<label>.t2.jsonl, … and parse-run.mjs
# stitches them back into one session.
#
# Env:   CG_BIN          codegraph binary (default: command -v codegraph)
#        AGENT_EVAL_OUT  output dir (default: /tmp/agent-eval)
#        MODEL / EFFORT  claude model/effort (default: sonnet / high — the
#                        standing A/B policy; see CLAUDE.md, don't raise)
set -uo pipefail

REPO="${1:?usage: run-all.sh <repo-path> \"<question>\" [headless|tmux|all]}"
Q="${2:?question required}"
MODE="${3:-headless}"

# Split "Q1||Q2||Q3" into turns (kept bash-3.2-safe: macOS ships 3.2).
TURNS=()
rest="$Q"
while [ "$rest" != "${rest#*||}" ]; do
  TURNS+=("${rest%%||*}")
  rest="${rest#*||}"
done
TURNS+=("$rest")
CG_BIN="${CG_BIN:-$(command -v codegraph)}"
OUT="${AGENT_EVAL_OUT:-/tmp/agent-eval}"
HARNESS="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"

# Neutralize any ambient CodeGraph prompt-hook (~/.claude) in BOTH arms:
# the hook injects codegraph context into every prompt, which contaminates
# the without-arm (free structural context) and double-counts the with-arm.
# The A/B's only variable must be the MCP server wired below.
export CODEGRAPH_NO_PROMPT_HOOK=1

# Hide the codegraph CLI from BOTH arms, so the only way to reach codegraph is
# the MCP server wired below — which is what makes it the A/B's single variable.
#
# Both arms have Bash, and the target repo carries the .codegraph/ index the
# with-arm needs. Agents FIND that: 14 of 15 without-arm runs in one 7-repo pass
# ran `codegraph explore` through Bash (one via `ls .codegraph && codegraph
# explore …`), so that arm was measuring codegraph-over-CLI, not
# codegraph-absent. It matters in the with-arm too — output that arrives through
# Bash is attributed to Bash, understating what codegraph itself occupies.
#
# The binary usually shares a directory with tools the run needs (claude itself
# lives next to it here), so dropping the whole directory is not an option.
# Substitute an equivalent directory IN PLACE: symlinks to every entry except
# codegraph, keeping PATH order and precedence intact.
SHIM_BIN="$OUT/nocg-bin"
rm -rf "$SHIM_BIN"; mkdir -p "$SHIM_BIN"
sanitized_path() {
  local out="" d e
  local IFS=:
  for d in $PATH; do
    [ -n "$d" ] || continue
    if [ -x "$d/codegraph" ]; then
      for e in "$d"/*; do
        [ "$(basename "$e")" = codegraph ] && continue
        ln -sf "$e" "$SHIM_BIN/" 2>/dev/null
      done
      d="$SHIM_BIN"
    fi
    out="${out:+$out:}$d"
  done
  printf '%s' "$out"
}
ARM_PATH="$(sanitized_path)"
if PATH="$ARM_PATH" command -v codegraph >/dev/null 2>&1; then
  echo "WARNING: 'codegraph' is still on the arm PATH — runs will be contaminated"
fi
for t in claude node; do
  PATH="$ARM_PATH" command -v "$t" >/dev/null || { echo "sanitized PATH lost '$t' — refusing to run"; exit 1; }
done

# Hiding it from PATH is not enough. An agent denied `codegraph` ran
# `find / -maxdepth 4 -iname "*codegraph*"`, found the binary, and invoked it by
# ABSOLUTE PATH — so block the invocation itself with a PreToolUse hook. Written
# into $OUT as a run artifact rather than a repo file, same as the MCP configs.
# The pattern deliberately matches only COMMAND positions: `grep codegraph x`,
# `ls .codegraph` and `which codegraph` are looking, not using, and pass through.
CG_CMD_RE='(^|[;&|(]|&&|\|\||\$\(|`)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*[A-Za-z0-9_./~-]*codegraph([[:space:]]|$)'
cat > "$OUT/no-cli-hook.sh" <<HOOK
#!/usr/bin/env bash
# Deny Bash invocations of the codegraph CLI so the MCP server stays the A/B's
# single variable. Looking for it is fine; running it is not.
set -uo pipefail
cmd="\$(cat | jq -r '.tool_input.command // empty' 2>/dev/null)"
if printf '%s' "\$cmd" | grep -Eq '$CG_CMD_RE'; then
  msg="The codegraph CLI is not available in this session. Answer using the tools you have."
  jq -n --arg m "\$msg" '{reason:\$m, hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:\$m}}'
fi
exit 0
HOOK
chmod +x "$OUT/no-cli-hook.sh"
cat > "$OUT/hook-settings.json" <<JSON
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash $OUT/no-cli-hook.sh"}]}]}}
JSON
command -v jq >/dev/null || { echo "jq is required for the CLI-block hook — install it or the arms will be contaminated"; exit 1; }
# Prove the hook denies a real invocation and lets a mere mention through.
_probe() { printf '{"tool_input":{"command":%s}}' "$1" | bash "$OUT/no-cli-hook.sh" | grep -c deny; }
[ "$(_probe '"/Users/x/.local/bin/codegraph explore \"q\""')" = 1 ] || { echo "hook fails to block an absolute-path invocation"; exit 1; }
[ "$(_probe '"grep -rn codegraph src/"')" = 0 ] || { echo "hook over-blocks a plain mention"; exit 1; }

[ -n "$CG_BIN" ] || { echo "no codegraph binary on PATH (set CG_BIN)"; exit 1; }
[ -d "$REPO/.codegraph" ] || { echo "no .codegraph index at $REPO — index it first"; exit 1; }
case "$MODE" in headless|tmux|all) ;; *) echo "mode must be headless|tmux|all (got '$MODE')"; exit 1;; esac

# MCP config files (path form avoids inline-JSON quoting through tmux).
cat > "$OUT/mcp-codegraph.json" <<JSON
{"mcpServers":{"codegraph":{"command":"$CG_BIN","args":["serve","--mcp","--path","$REPO"]}}}
JSON
echo '{"mcpServers":{}}' > "$OUT/mcp-empty.json"

echo "###### codegraph: $CG_BIN"
echo "###### repo:      $REPO"
echo "###### turns:     ${#TURNS[@]}"
for t in "${TURNS[@]}"; do echo "######   - $t"; done
echo

# Pull the session id out of a segment's result event so the next turn can
# --resume it (rather than minting a --session-id, which needs a valid uuid).
session_id_of() {
  node -e '
    const fs=require("fs");
    for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n").reverse()) {
      if (!l) continue; let e; try { e=JSON.parse(l) } catch { continue }
      if (e.session_id) { console.log(e.session_id); break }
    }' "$1" 2>/dev/null
}

# Headless arm: claude -p with stream-json -> exact tool sequence + tokens/cost
# + residual context occupancy. One session, one segment file per turn.
headless() {
  local label="$1" cfg="$2"
  echo "############################## HEADLESS [$label] ##############################"
  local sid="" seg=0 out="" files=()
  : > "$OUT/run-$label.err"
  for q in "${TURNS[@]}"; do
    seg=$((seg + 1))
    out="$OUT/run-$label.jsonl"
    [ "$seg" -gt 1 ] && out="$OUT/run-$label.t$seg.jsonl"
    local resume=()
    [ -n "$sid" ] && resume=(--resume "$sid")
    ( cd "$REPO" && PATH="$ARM_PATH" claude -p "$q" \
        --output-format stream-json --verbose \
        --permission-mode bypassPermissions \
        --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" \
        --max-budget-usd 4 \
        --strict-mcp-config --mcp-config "$cfg" \
        --settings "$OUT/hook-settings.json" \
        ${resume[@]+"${resume[@]}"} \
        </dev/null > "$out" 2>>"$OUT/run-$label.err" )
    echo "exit $? -> $out ($(wc -l < "$out" | tr -d ' ') lines) [turn $seg/${#TURNS[@]}]"
    files+=("$out")
    sid="$(session_id_of "$out")"
    if [ -z "$sid" ] && [ "$seg" -lt "${#TURNS[@]}" ]; then
      echo "  WARN: no session_id in $out — later turns would start a FRESH context; stopping this arm"
      break
    fi
  done
  tail -2 "$OUT/run-$label.err" 2>/dev/null
  node "$HARNESS/parse-run.mjs" "${files[@]}" 2>&1 || true
  echo
}

# CG_ARMS=with|without|both — re-run one arm without redoing the other.
ARMS="${CG_ARMS:-both}"
if [ "$MODE" = headless ] || [ "$MODE" = all ]; then
  case "$ARMS" in both|with)    headless "headless-with"    "$OUT/mcp-codegraph.json";; esac
  case "$ARMS" in both|without) headless "headless-without" "$OUT/mcp-empty.json";; esac
fi

if [ "$MODE" = tmux ] || [ "$MODE" = all ]; then
  echo "############################## INTERACTIVE [with] ##############################"
  CLAUDE_EXTRA_ARGS="--model ${MODEL:-sonnet} --effort ${EFFORT:-high} --strict-mcp-config --mcp-config $OUT/mcp-codegraph.json" \
    bash "$HARNESS/itrun.sh" "$REPO" "int-with" "${TURNS[0]}" 2>&1 || echo "[itrun WITH failed]"
  echo
  echo "############################## INTERACTIVE [without] ##############################"
  CLAUDE_EXTRA_ARGS="--model ${MODEL:-sonnet} --effort ${EFFORT:-high} --strict-mcp-config --mcp-config $OUT/mcp-empty.json" \
    bash "$HARNESS/itrun.sh" "$REPO" "int-without" "${TURNS[0]}" 2>&1 || echo "[itrun WITHOUT failed]"
  echo
fi
echo "############################## RUN-ALL COMPLETE ##############################"
