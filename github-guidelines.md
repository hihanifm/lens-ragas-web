# GitHub workflow guidelines (public upstream + private origin)

This repo is developed **open source** on public GitHub, and also mirrored to a **private/internal GitHub** for lab-specific work (e.g., internal LLM adapters).

The goal is:
- **Pull updates from public** (upstream) safely
- **Push only to private** (origin)
- Keep the two histories easy to sync with minimal merge pain
- Prevent accidental pushes to public GitHub

These rules are written so a coding agent (e.g., Cline) can follow them reliably.

---

## Remotes and branch model

- **`upstream`** = public GitHub repo (**fetch-only**; pushing is disabled)
- **`origin`** = private/internal GitHub repo (**the only push target**)

Two local “main equivalents”:
- **`public-main`** tracks `upstream/main`
- **`private-main`** tracks `origin/main`

Work branches should be created from **`private-main`** and pushed only to **`origin`**.

---

## One-time setup (run in a fresh clone)

Create and run this setup script from the repo root.

Save as `git-dual-remote-setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "== Dual-remote setup (public upstream + private origin) =="

# Auto-detect the public URL from an existing clone when possible:
# - public: github.com
# - private/internal: github.<corp>.com (or anything not github.com)
PUBLIC_URL=""
PRIVATE_URL=""

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
  read -r -p "Public GitHub repo URL (github.com, fetch-only): " PUBLIC_URL
else
  echo "Detected public repo: $PUBLIC_URL"
fi

if [[ -z "$PRIVATE_URL" ]]; then
  read -r -p "Private/internal GitHub repo URL (github.<corp>.com, push target): " PRIVATE_URL
else
  echo "Detected private repo: $PRIVATE_URL"
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
- Prefer working from **`private-main`** for any changes that will be pushed.
- Treat public GitHub as **read-only** in this clone.
- Before pushing, run `git where` and confirm `upstream` push URL is `DISABLED`.

