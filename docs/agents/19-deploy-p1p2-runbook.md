# Deploy P1 + P2 — Step-by-step guide for the operator

> **Time:** ~15 minutes
> **Tools needed:** GitHub account (admin), SSH access to VPS

The code is **ready to push** in 3 commits on `main` (4a64e18, 9319602, 4e4b108).
Pushing without finishing the steps below will break the site because the
deploy workflow now REQUIRES the SOPS_AGE_KEY secret to be set.

---

## Step 1 — Set the GitHub secret (5 min)

1. Go to https://github.com/Sonlak/netconsole/settings/secrets/actions
2. Click **New repository secret**
3. Fill in:
   - **Name:** `SOPS_AGE_KEY`
   - **Value:** paste the line below EXACTLY (one line, no trailing newline):
     ```
     AGE-SECRET-KEY-1093HJZK8W7CL4449T22TDT23GJYHSSFNFSQGCXKG8F4ZTGMPZCMQS3PLQH
     ```
4. Click **Add secret**

---

## Step 2 — Put the private key on the VPS (3 min)

```bash
# On your local machine (Windows):
scp D:\NetConsole\secrets.age.key sonnx@100.102.133.86:/opt/netconsole/.sops-age-key.txt

# On the VPS:
ssh sonnx@100.102.133.86
chmod 600 /opt/netconsole/.sops-age-key.txt
ls -la /opt/netconsole/.sops-age-key.txt
# expected: -rw------- 1 sonnx sonnx 177 ...  .sops-age-key.txt
```

---

## Step 3 — Push the commits (1 min)

```bash
cd D:\NetConsole
git push origin main
```

This triggers the deploy. Watch at https://github.com/Sonlak/netconsole/actions

---

## Step 4 — Verify the deploy (5 min)

The deploy runs the new "Decrypt secrets.env.enc" step. Check it succeeds:

- In the GH Actions run, expand the **"Decrypt secrets.env.enc"** step
- Expected output:
  ```
  ==> Using age key from SOPS_AGE_KEY_CMD env var
  ==> Decrypting secrets.env.enc → secrets.env
  ✅ Decrypted secrets.env.enc → secrets.env (45 lines)
  ✅ secrets.env decrypted; required vars present
  ```
- **"Wait for backend healthy"** should still pass
- Container health: `curl -k -sS https://127.0.0.1:8443/api/health` → 200

If the decrypt step fails with `no identity matched any of the recipients`,
the GH secret value was entered incorrectly. Edit the secret, do NOT push
again — the deploy workflow will run on its own when the next push happens.

---

## Step 5 — Smoke test the new TOTP feature (5 min)

After the deploy is green, test P2 end-to-end:

1. Open https://netconsole.tailocbank.vn (or https://42.119.165.109:8443)
2. Login as admin (or any user) — should work as before (no TOTP required
   yet, since the admin user is not enrolled)
3. Click your avatar (top right) → **"Two-factor authentication"**
4. Click **"Start setup"** → scan QR with Google Authenticator / 1Password
5. Enter a 6-digit code → click Verify → TOTP enabled
6. **Save the 10 backup codes** somewhere safe (password manager)
7. Log out, log back in — now you'll see the TOTP challenge screen
8. Enter a 6-digit code → access granted

If anything fails, check the backend log:
```bash
ssh sonnx@100.102.133.86
docker logs --tail 50 netconsole-backend 2>&1 | grep -E '\[auth\]|\[totp\]'
```

---

## What's in the commits

| SHA | What |
|---|---|
| `4a64e18` | P1: SOPS + age config, scripts, deploy workflow integration |
| `9319602` | P2: TOTP 2FA + forced change + admin reset (full stack) |
| `4e4b108` | P1 finalize: encrypted secrets.env.enc, .gitattributes LF, script fixes |

Total: 3 commits, 26 files, ~3400 LoC.

---

## Backlog (do after this deploy is stable)

- [ ] All admin/operator users should enroll TOTP (audit reminder)
- [ ] NetBox admin password rotation per RB-LB-4
- [ ] Set `TOTP_REQUIRED_ENROLLMENT_AFTER` env to enforce enrollment by deadline
- [ ] Per-IP rate limit on `/api/auth/mfa/verify`
- [ ] The plaintext `secrets.env` on VPS should now be DELETED (the
      encrypted file in git + the age key on VPS is sufficient to
      reconstruct it). Keep a backup encrypted backup, never plaintext.
