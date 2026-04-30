---

## name: github-public-upstream-private-origin
description: Safe git workflow for OSS upstream + private mirror (disable public pushes, sync via public-main/private-main)
version: 1.0
applies_to: ["git", "github", "release-workflow"]
rules:
  - Never push to public GitHub
  - upstream is fetch-only; upstream push URL must be DISABLED
  - Only push to origin (private/internal)
  - Prefer working on private-main or branches from it
  - Before any push, run `git where` and verify remotes
usage:
  - Run the one-time setup script from repo root
  - Use aliases: pub-pull, priv-pull, priv-push

# SKILL: Public upstream + private origin Git workflow

## Purpose

Use this workflow when you develop a project **open source** on public GitHub, but also maintain a **private/internal mirror** for lab-only changes. It prevents accidental public pushes and keeps upstream merges smooth.

## Non‑negotiable rules (agents must honor)

- **Never push to public GitHub**.
- `upstream` is **fetch-only** (its push URL must be **DISABLED**).
- Only push to `origin` (private/internal).
- Do work on `private-main` (or feature branches created from it).
- Before any push: run `git where` and verify:
  - `origin` is **not** `github.com`
  - `upstream` push URL is **DISABLED**

---

## Remotes and branch model

- `**upstream`** = public GitHub repo (**fetch-only**; pushing is disabled)
- `**origin`** = private/internal GitHub repo (**the only push target**)

Two local “main equivalents”:

- `**public-main`** tracks `upstream/main`
- `**private-main**` tracks `origin/main`

Work branches should be created from `**private-main**` and pushed only to `**origin**`.

---

## One-time setup (run in a fresh clone)

Create and run this setup script from the repo root.

Save as `git-dual-remote-setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "== Dual-remote setup (public upstream + private origin) =="

# Non-interactive agents (like Cline) may not show prompts.
# If stdin is not a TTY, require PRIVATE_URL to be provided explicitly.
IS_TTY=0
if [[ -t 0 ]]; then IS_TTY=1; fi

# Auto-detect the public URL from an existing clone when possible:
# - public: github.com
# - private/internal: github.<corp>.com (or anything not github.com)
PUBLIC_URL=""
PRIVATE_URL="${PRIVATE_URL:-}"

if git remote get-url origin >/dev/null 2>&1; then
  ORIGIN_URL="$(git remote get-url origin)"
  if [[ "$ORIGIN_URL" == *"github.com"* ]]; then
    PUBLIC_URL="$ORIGIN_URL"
  else
    PRIVATE_URL="$ORIGIN_URL"
  fi
fi

if [[ -z "$PUBLIC_URL" ]] && git remote get-url upstream >/dev/null 2>&1; then
  UPSTREAM_URL="$(git remote get-url upstream)"
  if [[ "$UPSTREAM_URL" == *"github.com"* ]]; then
    PUBLIC_URL="$UPSTREAM_URL"
  fi
fi

if [[ -z "$PUBLIC_URL" ]]; then
  if [[ "$IS_TTY" -eq 1 ]]; then
    read -r -p "Public GitHub repo URL (github.com, fetch-only): " PUBLIC_URL
  else
    echo "ERROR: Could not auto-detect PUBLIC_URL and prompts are disabled (non-interactive)."
    echo "Set PUBLIC_URL env var or run this script in an interactive terminal."
    exit 2
  fi
else
  echo "Detected public repo: $PUBLIC_URL"
fi

if [[ -z "$PRIVATE_URL" ]]; then
  if [[ "$IS_TTY" -eq 1 ]]; then
    read -r -p "Private/internal GitHub repo URL (github.<corp>.com, push target): " PRIVATE_URL
  else
    echo "ERROR: PRIVATE_URL is required in non-interactive mode."
    echo "Example: PRIVATE_URL=https://github.<corp>.com/org/repo.git ./git-dual-remote-setup.sh"
    exit 2
  fi
else
  echo "Detected private repo: $PRIVATE_URL"
fi

# Guardrail: private URL must not be github.com
if [[ "$PRIVATE_URL" == *"github.com"* ]]; then
  echo "ERROR: PRIVATE_URL points to github.com. Refusing to configure a public repo as private."
  echo "PRIVATE_URL=$PRIVATE_URL"
  exit 2
fi

DEFAULT_BASE_BRANCH="main"
read -r -p "Base branch name [${DEFAULT_BASE_BRANCH}]: " BASE_BRANCH
BASE_BRANCH="${BASE_BRANCH:-$DEFAULT_BASE_BRANCH}"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not in a git repo."; exit 1; }

echo "-> Configuring remotes..."

# origin = private (push target)
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$PRIVATE_URL"
else
  git remote add origin "$PRIVATE_URL"
fi

# upstream = public (fetch only)
if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$PUBLIC_URL"
else
  git remote add upstream "$PUBLIC_URL"
fi

# Disable accidental push to upstream
git remote set-url --push upstream DISABLED || true

# Prefer pushing to origin by default
git config remote.pushDefault origin

echo "-> Fetching..."
git fetch origin --prune
git fetch upstream --prune

echo "-> Creating local branches..."

# public-main tracks upstream/main
if git show-ref --verify --quiet refs/heads/public-main; then
  echo "   public-main already exists"
else
  git branch public-main "upstream/${BASE_BRANCH}"
fi
git branch --set-upstream-to="upstream/${BASE_BRANCH}" public-main >/dev/null 2>&1 || true

# private-main tracks origin/main
if git show-ref --verify --quiet refs/heads/private-main; then
  echo "   private-main already exists"
else
  git branch private-main "origin/${BASE_BRANCH}"
fi
git branch --set-upstream-to="origin/${BASE_BRANCH}" private-main >/dev/null 2>&1 || true

echo "-> Adding helpful aliases..."
git config alias.pub-pull  "!git fetch upstream --prune && git switch public-main && git reset --hard upstream/${BASE_BRANCH}"
git config alias.priv-pull "!git fetch origin --prune && git switch private-main && git reset --hard origin/${BASE_BRANCH}"
git config alias.priv-push "!git push origin HEAD"
git config alias.where     "remote -v"

cat <<EOF

Done.

Daily shortcuts:
- git pub-pull   : update public-main from upstream/${BASE_BRANCH} (hard reset)
- git priv-pull  : update private-main from origin/${BASE_BRANCH} (hard reset)
- git priv-push  : push current HEAD to private origin
- git where      : show remotes

Safety:
- 'upstream' push URL is DISABLED.

EOF
```

Then:

```bash
chmod +x git-dual-remote-setup.sh
./git-dual-remote-setup.sh
```

### Cline / non-interactive quick-start

Agents often run without interactive prompts. Use:

```bash
PRIVATE_URL="https://github.<corp>.com/<org>/<repo>.git" ./git-dual-remote-setup.sh
```

---

## Daily commands (agent-safe)

### Pull latest public OSS (`upstream/main`)

```bash
git pub-pull
```

### Pull latest private/internal (`origin/main`)

```bash
git priv-pull
```

### Push (private only)

```bash
git priv-push
```

### Switch between “mains”

```bash
git switch public-main
git switch private-main
```

### Confirm push safety

```bash
git where
```

You should see `upstream` push URL set to `DISABLED`.

---

## Syncing public changes into private

Typical flow:

```bash
git pub-pull
git switch private-main
git merge public-main
```

If you prefer rebase:

```bash
git pub-pull
git switch private-main
git rebase public-main
```

Then push only to private:

```bash
git priv-push
```

---

## Rules for coding agents (Cline, etc.)

- **Never push to `upstream`**.
- **Only push to `origin`**.
- Prefer working from `**private-main**` for any changes that will be pushed.
- Treat public GitHub as **read-only** in this clone.
- Before pushing, run `git where` and confirm `upstream` push URL is `DISABLED`.

## Examples (copy/paste)

### Sync latest OSS changes into private and push

```bash
git pub-pull
git switch private-main
git merge public-main
git priv-push
```

### Sanity-check remotes before pushing

```bash
git where
```

