# NetConsole — SOPS + age for `secrets.env` (P1)

> **Status:** ✅ Code changes ready. Operator setup required (see below) before first deploy.
> **Replaces:** the previous "operator maintains `secrets.env` on the VPS, never in git" pattern.
> **What changed:** `secrets.env` is now encrypted with [SOPS](https://github.com/mozilla/sops) + [age](https://age-encryption.org) and committed as `secrets.env.enc`. The deploy workflow decrypts it on the VPS.

## Why

The previous pattern was:
- `secrets.env` is gitignored, never committed.
- Operator SSHes to VPS, runs `./scripts/rotate_secrets.sh` to write the file.
- File is the source of truth on the VPS; git history has nothing.

Problems with that:
- No version history of changes.
- VPS is the only place the file exists; lost if VPS disk dies.
- No code review on secret changes.
- A backup that *was* taken via rsync (`.sops-age-key.txt.bak` etc.) silently
  leaves plain copies on operators' laptops.

The new pattern:
- `secrets.env.enc` is committed, encrypted with the age public key in `.sops.yaml`.
- Plaintext `secrets.env` is generated on the VPS at deploy time via the
  age private key stored in GitHub Actions secret `SOPS_AGE_KEY`.
- Changes go through git → code review → encrypted commit → auto-deploy.
- Plaintext file never leaves the VPS.

## One-time operator setup

### 1. Generate an age key pair (local machine)

```bash
# Install age (macOS: brew install age, Linux: see GitHub releases)
age-keygen -o /tmp/age.key
cat /tmp/age.key
```

Output:
```
# created: 2026-10-19T...
# public key: age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3awx4u
AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ
```

The line starting with `AGE-SECRET-KEY-` is the **private key**.
The line starting with `age1` is the **public key**.

### 2. Update `.sops.yaml` with the public key

```bash
# Edit .sops.yaml, replace the PLACEHOLDER with your age1... public key:
sed -i '' 's|age1PLACEHOLDERREPLACEMEWITHYOURACTUALPUBLICKEY|age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3awx4u|' .sops.yaml
```

Commit `.sops.yaml`.

### 3. Set the private key in GitHub Actions

1. Go to https://github.com/Sonlak/netconsole/settings/secrets/actions
2. Click **New repository secret**
3. Name: `SOPS_AGE_KEY`
4. Value: paste the full `AGE-SECRET-KEY-...` line from `cat /tmp/age.key`

### 4. Set the private key on the VPS

```bash
scp /tmp/age.key sonnx@100.102.133.86:/opt/netconsole/.sops-age-key.txt
ssh sonnx@100.102.133.86 "chmod 600 /opt/netconsole/.sops-age-key.txt"
```

This file is in `.gitignore` and will not be synced from git.

### 5. Install SOPS + age on the VPS

The deploy workflow installs them automatically on the self-hosted runner.
For manual operations (e.g. decrypting outside of a deploy), install them now:

```bash
# sops
sudo curl -sSLo /usr/local/bin/sops https://github.com/mozilla/sops/releases/download/v3.10.2/sops-v3.10.2.linux.amd64
sudo chmod +x /usr/local/bin/sops

# age
sudo apt install -y age
```

### 6. Generate the first encrypted secrets file

On your local machine, after the operator has run `rotate_secrets.sh --initial`
on the VPS to create a plaintext `secrets.env`:

```bash
# Pull the plaintext from VPS
scp sonnx@100.102.133.86:/opt/netconsole/secrets.env ./

# Encrypt it
./scripts/sops_encrypt.sh

# Commit + push
git add secrets.env.enc
git commit -m "chore: initial encrypted secrets (SOPS + age)"
git push origin main
```

The next deploy will pick it up automatically.

## Operator workflow after P1

### Day-to-day: nothing changes for most users

Deploys work exactly as before. The `secrets.env` on the VPS is now
derived from `secrets.env.enc` via the deploy workflow's decrypt step.

### Rotating JWT_SECRET / WORKER_AUTH_TOKEN

```bash
# On the VPS, with the age key in place:
cd /opt/netconsole
./scripts/sops_decrypt.sh                  # secrets.env.enc → secrets.env
./scripts/rotate_secrets.sh                # rotate; restart services
# Then re-encrypt + push:
sops --input-type=dotenv --output-type=dotenv \
  --encrypt secrets.env > secrets.env.enc
git add secrets.env.enc
git commit -m "chore: rotate JWT_SECRET + WORKER_AUTH_TOKEN"
git push origin main
```

The next deploy picks up the new values; all user sessions invalidate
(the same behavior as before P1).

### Updating a vendor password

```bash
# Locally, edit the plaintext (kept in your password manager, NOT in git):
#   1. decrypt: ./scripts/sops_decrypt.sh
#   2. vim secrets.env
#   3. encrypt: ./scripts/sops_encrypt.sh
#   4. git add secrets.env.enc && git commit && git push
```

The PR is reviewable: only the changed value is encrypted, the rest of
the file is unchanged (SOPS only encrypts values matching the
`encrypted_regex` in `.sops.yaml`).

## Key rotation

To rotate the age key (recommended every 12 months):

1. Generate a new key pair (`age-keygen -o age-v2.key`).
2. Update `.sops.yaml` with the new public key.
3. Re-encrypt: `./scripts/sops_encrypt.sh` (sops prompts to confirm key change).
4. Update GitHub secret `SOPS_AGE_KEY` with the new private key.
5. Update VPS file `/opt/netconsole/.sops-age-key.txt` with the new private key.
6. Commit `.sops.yaml` + `secrets.env.enc` + push.
7. Old private key can then be discarded.

## Files added / changed by P1

| File | Change | Why |
|---|---|---|
| `.sops.yaml` | new | SOPS config: tells sops which values to encrypt + which age key to use |
| `secrets.env.enc` | new (git-tracked) | Encrypted form of `secrets.env` |
| `scripts/sops_encrypt.sh` | new | Encrypts `secrets.env` → `secrets.env.enc` (run locally) |
| `scripts/sops_decrypt.sh` | new | Decrypts `secrets.env.enc` → `secrets.env` (run on VPS) |
| `scripts/rotate_secrets.sh` | updated | Prints re-encrypt instructions after rotation |
| `.github/workflows/deploy.yml` | updated | Installs SOPS + age; decrypts before `docker compose` |
| `.gitignore` | updated | Excludes `*.sops-age-key.txt`, `age-priv.txt`, `age.key` |
| `docs/agents/18-sops-secrets-management.md` | new | This file |

## Verification

After setup, verify end-to-end:

```bash
# 1. Local: encrypt a test value, see the cipher
echo "TEST=hunter2" >> secrets.env
./scripts/sops_encrypt.sh
git diff secrets.env.enc          # should show one line encrypted
git checkout secrets.env          # revert local change

# 2. VPS: decrypt
ssh sonnx@100.102.133.86
cd /opt/netconsole
./scripts/sops_decrypt.sh
grep TEST secrets.env              # should print TEST=hunter2

# 3. Deploy: trigger a push to main
git push origin main
# In CI: the "Decrypt secrets.env.enc" step should pass.
```

## Threat model

- ✅ Repo is public: an attacker reading `secrets.env.enc` gets ciphertext only.
- ✅ GitHub repo compromised: attacker has no age key (stored in GH secrets,
  which require additional access).
- ⚠️ VPS compromised: attacker has both `secrets.env` (plaintext) and
  `.sops-age-key.txt`. Mitigate with file-system encryption (LUKS) + IP allowlist.
- ⚠️ GH Actions secret leak: rotate the age key immediately + re-encrypt.
- ⚠️ Operator laptop compromised: same as VPS compromised.

## Future enhancements (backlog)

- Auto-decrypt the file at deploy time without writing it to disk (use `sops exec-env`).
- Use multiple age keys (e.g. one for each operator) for multi-party decryption.
- Migrate vendor creds to Vault / Doppler instead of .env file.
