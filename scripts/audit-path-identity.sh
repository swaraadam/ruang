#!/usr/bin/env bash
# Path-identity audit — DRAFT, awaiting owner apply.
#
# WHAT IT CATCHES, AND WHY IT EXISTS
#
# One defect shape appeared three times on three different seams on 2026-09-14, written by three
# different agents, and each time a reviewer that READ the code passed it:
#
#   #72 C2  autostart.ts:14   `${env.home}/Library/LaunchAgents/${unit_id}.plist`
#                             '../../../../tmp/pwn' wrote an arbitrary .plist; status() was a
#                             read oracle for any readable file.
#   #74 C1  sandbox.ts:16     join(o.sandbox_root, o.project_id, sandbox_id) then
#                             rmSync(recursive, force) -> '../precious' deleted a directory
#                             outside both roots and reported refused_reason: null.
#   #84 M1  server.ts:182     existsSync(dbPath) treated as identity -> a symlink to a foreign
#                             SQLite file got all 26 control-plane tables created inside it.
#
# On #74 the author had ALREADY written the guard correctly in two of three places (checks.ts:91
# sanitises check_id, basis.ts:36-41 validates traversal in versionOf) and missed the third. That
# is what an audit catches and a reader does not: not ignorance, an omission.
#
# THE RULE
#
# A caller-supplied value must not reach a filesystem path without an identity check. Two syntactic
# shapes are checked, because the real defects used both:
#
#   (a) a path sink or path builder called with a non-literal argument
#   (b) a template literal that contains BOTH a path separator and an interpolation
#
# For each candidate, the identifiers feeding it are extracted, and the file must pass at least one
# of them through a validator CALL. Checking the specific identifier -- not merely "this file
# mentions a validator somewhere" -- is what catches the #74 case, where the same file guarded one
# identifier and not another.
#
# THE ESCAPE HATCH IS DELIBERATE
#
#     // path-identity: <why this value cannot escape its root>
#
# The point is not to make exceptions impossible. It is to make every one greppable, so "which
# values reach a path in this repo?" has an answer shorter than reading every file. An annotation
# that does not say why is a defect in its own right.
#
# WHAT IT DOES NOT CATCH — read this before trusting it
#
#   - Dataflow. Line- and file-scoped, not taint analysis. A value laundered through a helper in
#     another file is invisible to it.
#   - #84's M1 shape. "Existence is not identity" is semantic, not syntactic; no grep separates
#     existsSync-as-precondition from existsSync-as-identity-check. M1 is cited above because it is
#     the same RULE, not because this script finds it. A pass is not evidence against it.
#   - Whether a validator that IS called is correct. #72's guard was called and inspected argv[0],
#     which was always 'tmux'.
#
# It is a net under one recurring omission, not a proof of safety. Exit 0 = clean, 1 = violation.
#
# VALIDATED against the three defects above at their pre-fix SHAs; see the run log for 2026-09-14.

set -uo pipefail
cd "$(dirname "$0")/.."

QUIET=0
[[ "${1:-}" == "--quiet-on-pass" ]] && QUIET=1

fail=0
report() { echo "PATH-IDENTITY AUDIT FAIL: $1"; shift; printf '  %s\n' "$@"; fail=1; }

SCAN=()
for d in packages apps adapters; do [[ -d "$d" ]] && SCAN+=("$d"); done
[[ ${#SCAN[@]} -eq 0 ]] && { echo "PATH-IDENTITY AUDIT PASS"; exit 0; }

TMPOUT="$(mktemp)"
trap 'rm -f "$TMPOUT"' EXIT

# Heredoc deliberately OUTSIDE a $( ) substitution: bash scans command substitutions for a matching
# paren and treats backticks inside them as nested substitution, which mangles the regexes below.
python3 - "${SCAN[@]}" > "$TMPOUT" <<'PYEOF'
import os, re, sys

SINKS = r"(?:rmSync|rmdirSync|unlinkSync|writeFileSync|appendFileSync|copyFileSync|readFileSync|mkdirSync|existsSync|statSync|lstatSync|realpathSync|createWriteStream|createReadStream|openDatabase|renameSync|symlinkSync|readdirSync)"
BUILDERS = r"(?:join|resolve)"
CALL = re.compile(rf"\b(?:{SINKS}|{BUILDERS})\s*\(([^)]*)\)")
# a template literal carrying both a path separator and an interpolation
TMPL = re.compile(r"`[^`]*/[^`]*\$\{[^}]+\}[^`]*`|`[^`]*\$\{[^}]+\}[^`]*/[^`]*`")
IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
# a validator used as a CALL, not a word in prose
VALIDATOR_CALL = re.compile(
    r"\b(?:assertSafe[A-Za-z]*|sanitize[A-Za-z]*|assertWithinRoot|pathPolicy|path_policy"
    r"|isSafe[A-Za-z]*|validate[A-Za-z]*|refuse[A-Z][A-Za-z]*|guard[A-Za-z]*)\s*\("
)
ANNOT = re.compile(r"path-identity:")
PARAM_DECL = re.compile(r"\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*[A-Za-z_$\[{]")
LOCAL_DECL = re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=")
# Markup, not a filesystem path: a template building XML/HTML is not this audit's business.
MARKUP = re.compile(r"[<>]")
SKIP_DIR = re.compile(r"[/\\](?:dist|node_modules|\.git)[/\\]")
SKIP_FILE = re.compile(r"\.(?:test|spec)\.ts$|\.contract\.test\.ts$|\.d\.ts$")
COMMENT = re.compile(r"^\s*(?://|\*|/\*)")
LITERAL_ONLY = re.compile(r"^[\s'\"`][^$]*$")

def idents(expr):
    out = set()
    for m in re.finditer(r"\$\{([^}]*)\}", expr):
        for i in IDENT.findall(m.group(1)):
            out.add(i.split(".")[0])
    for part in expr.split(","):
        part = part.strip()
        if not part or part[0] in "'\"`":
            continue
        m = IDENT.match(part)
        if m:
            out.add(m.group(0))
    return {i for i in out if i not in {"join", "resolve", "process", "String", "Number", "this"}}

findings = []
for root in sys.argv[1:]:
    for dirpath, _, files in os.walk(root):
        if SKIP_DIR.search(dirpath + os.sep):
            continue
        for fn in files:
            if not fn.endswith((".ts", ".tsx", ".js", ".mjs")) or SKIP_FILE.search(fn):
                continue
            path = os.path.join(dirpath, fn)
            try:
                lines = open(path, encoding="utf-8").read().split("\n")
            except Exception:
                continue
            validated = set()
            params = set()
            locals_ = set()
            for ln in lines:
                if VALIDATOR_CALL.search(ln):
                    for i in IDENT.findall(ln):
                        validated.add(i)
                # A typed binding `name: Type` is a parameter or a field -- i.e. a value that
                # arrived from outside this function. Those are the ones worth auditing.
                for m in PARAM_DECL.finditer(ln):
                    params.add(m.group(1))
                # A local assigned from an expression is derived, not caller-supplied. Flagging
                # every `const dir = ...` downstream buries the one line that matters: on the #74
                # tree that was 20 derived locals around 3 real findings.
                for m in LOCAL_DECL.finditer(ln):
                    locals_.add(m.group(1))
            params -= locals_
            for n, ln in enumerate(lines, 1):
                if COMMENT.match(ln) or ANNOT.search(ln):
                    continue
                if n > 1 and ANNOT.search(lines[n - 2]):
                    continue
                cand = set()
                for m in CALL.finditer(ln):
                    arg = m.group(1)
                    if LITERAL_ONLY.match(arg):
                        continue
                    cand |= idents(arg)
                for m in TMPL.finditer(ln):
                    tmpl = m.group(0)
                    if MARKUP.search(tmpl):
                        continue
                    # The separator must sit OUTSIDE the interpolations. `${a}/Library/${b}.plist`
                    # is a path; `${r.sql.replace(/\s+/g, " ")}` only contains a slash because a
                    # regex literal lives inside the expression. Stripping ${...} separates them.
                    if "/" not in re.sub(r"\$\{[^}]*\}", "", tmpl):
                        continue
                    cand |= idents(tmpl)
                if not cand:
                    continue
                if cand & validated:
                    continue
                # Only caller-supplied values, not values this file derived itself.
                cand &= params
                if not cand:
                    continue
                findings.append(f"{path}:{n}: {ln.strip()[:110]}")
print("\n".join(findings))
PYEOF

hits="$(cat "$TMPOUT")"

if [[ -n "${hits//[$'\n' ]/}" ]]; then
  report "caller-supplied value reaches a path with no identity check" "$hits"
fi

if [[ $fail -eq 0 ]]; then
  [[ $QUIET -eq 1 ]] || echo "PATH-IDENTITY AUDIT PASS"
  exit 0
fi
echo
echo "Fix by (in order): route the value through the validator this repo already has ·"
echo "refuse the value outright · annotate with '// path-identity: <why it cannot escape>'."
echo "Do NOT widen the validator to admit the value. See #86."
exit 1
