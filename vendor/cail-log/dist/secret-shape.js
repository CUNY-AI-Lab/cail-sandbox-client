const SECRET_SHAPED_VALUE_RE = /(?:^|[^a-z0-9])(?:(?:[sr]k_(?:live|test)_|sk-[A-Za-z0-9_-]{8,})|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|gh[opusr]_|github_pat_|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-|eyJ[a-zA-Z0-9_-]{8,}\.)/;
export function isSecretShaped(value) {
    return SECRET_SHAPED_VALUE_RE.test(value);
}
