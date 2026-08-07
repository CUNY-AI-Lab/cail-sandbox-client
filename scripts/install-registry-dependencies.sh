#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${NODE_AUTH_TOKEN:-}" ]]; then
  printf 'NODE_AUTH_TOKEN must be non-empty\n' >&2
  exit 64
fi

if [[ -e .npmrc && ! -f .npmrc && ! -L .npmrc ]]; then
  printf '.npmrc must be a regular file or symlink\n' >&2
  exit 65
fi

umask 077
temporary_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
config_path=""
backup_dir=""
had_npmrc=0

restore_npmrc() {
  local status=$?
  trap - EXIT HUP INT TERM

  if [[ "$had_npmrc" -eq 1 ]]; then
    # If the temporary config was moved into place, restore the exact prior
    # file (including its mode or symlink shape). If a signal arrived before
    # that atomic move, the original remains in place.
    if [[ -n "$config_path" && ! -e "$config_path" && ! -L "$config_path" ]]; then
      rm -f .npmrc
      mv "$backup_dir/original" .npmrc
    fi
  else
    if [[ -n "$config_path" && ! -e "$config_path" && ! -L "$config_path" ]]; then
      rm -f .npmrc
    fi
  fi
  if [[ -n "$config_path" ]]; then
    rm -f "$config_path"
  fi
  if [[ -n "$backup_dir" ]]; then
    rm -rf "$backup_dir"
  fi
  exit "$status"
}

trap restore_npmrc EXIT HUP INT TERM

if [[ -e .npmrc || -L .npmrc ]]; then
  backup_dir="$(mktemp -d "${temporary_root%/}/cail-sandbox-client-npmrc-backup.XXXXXX")"
  cp -a .npmrc "$backup_dir/original"
  had_npmrc=1
fi

unset NPM_CONFIG_USERCONFIG
config_path="$(mktemp "${temporary_root%/}/cail-sandbox-client-npmrc.XXXXXX")"
printf '@cuny-ai-lab:registry=https://npm.pkg.github.com\n' > "$config_path"
printf '//npm.pkg.github.com/:_authToken=%s\n' "$NODE_AUTH_TOKEN" >> "$config_path"
mv "$config_path" .npmrc
bun install --frozen-lockfile --ignore-scripts
