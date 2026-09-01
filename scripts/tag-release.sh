#!/usr/bin/env bash
# Tag the version in package.json and push it, which starts the Release
# workflow. Manual tagging is how the published releases drifted nine months
# behind the code, so this keeps the tag and package.json in step by
# construction.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

version="$(bun -e 'console.log(require("./package.json").version)')"
tag="v${version}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash first." >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "master" && "$branch" != "main" ]]; then
  echo "On branch '$branch'. Release from master or main unless you know why not." >&2
  read -r -p "Continue anyway? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || exit 1
fi

# refs/tags/ explicitly: a bare name also resolves branches, so a branch sharing
# the tag's name would block a tag that does not exist yet.
if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "Tag $tag already exists. Bump the version in package.json first." >&2
  exit 1
fi

echo "Tagging $tag at $(git rev-parse --short HEAD) on $branch."
git tag -a "$tag" -m "$tag"
git push origin "$tag"
echo "Pushed $tag. The Release workflow builds, tests and publishes it."
