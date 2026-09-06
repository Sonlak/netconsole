Get-Content AGENTS.md -Encoding UTF8
### 2026-09-07 00:22 -- UI footer cleanup (drop Build + fix font)

- User asked to: (1) drop the "(Build 20260906)" part of the footer,
  (2) re-look at the font. The current monospace stack read as a code
  stamp rather than brand chrome.

- Files touched:
  - `frontend/src/layouts/AppLayout.tsx` line 270-273:
    Footer text rewritten:
    - "Version: 1.2.0 (Build 20260906)" -> "NetConsole 1.2.0"
    - "(c) 2026 SonLak." -> "SonLak Network Operations"
    (The original "(c)" was cp1252-corrupted to a tofu glyph at
    render time; switching to pure ASCII sidesteps the encoding trap
    called out in the previous session's lesson.)
  - `frontend/src/styles/antd-bridge.css` line 136-167:
    `.nc-app-footer` font switched from `var(--font-mono)` (JetBrains
    Mono / ui-monospace) to `var(--font-sans)` (Inter Variable / Inter
    / ui-sans-serif) so the footer matches the sidebar nav text.
    `.nc-app-footer-copy` color bumped #657384 -> #6b7889 for better
    line separation between version + tagline.

- Verification: preview HTML at /__preview-footer.html with the
  rebuilt CSS bundle loaded; sidebar nav + footer both render in Inter
  sans at 11px, version "NetConsole 1.2.0" + tagline "SonLak Network
  Operations" both render cleanly with no glyph fallbacks.

- Commit: `2d64aaf fix(ui): drop Build label + switch footer to Inter
  sans`. CI green, Deploy green, frontend container restarted on VPS.

- Lessons for next agent:
  - **Footer chrome should inherit the body font, not pick a mono
    stack.** Monospace in a sidebar footer reads as a build label or
    a console stamp, not a version badge. Use `var(--font-sans)` so
    the footer matches whatever the rest of the chrome uses.
  - **For copyright / version lines, prefer pure ASCII.** Any
    non-ASCII glyph (including the trivial (c) U+00A9) is a
    transcoding risk on Windows + PowerShell + cp1252 default
    console. The AGENTS.md note from the previous session spells
    this out: write ASCII in source files, render fancy glyphs only
    when the user asks for them and verify the actual byte stream
    after save.
  - **When the user says "coi font lai" they usually mean "it doesn't
    look right" -- not "I want a different font family".** Check
    whether the text is monospace / too small / wrong weight first;
    the user is reacting to the visual feel, not asking for a font
    audit. In this case both applied -- monospace + cp1252 mangling
    on the copyright char -- so the fix was both font + text.
