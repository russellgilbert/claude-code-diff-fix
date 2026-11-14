# Claude Code CRLF Diff Bug — Fix Instructions

## NOTE: Anthropic fixed the CRLF bug in version 2.1.323 of the extension

Anthropic's changelog entry for version 2.1.323 reads:

> [VSCode] Fixed the diff tab not opening for multi-line edits on files with CRLF line endings

The extension now does the line-ending handling itself — it normalizes the file content and the edit strings, applies the edit, then restores CRLF if that's what the file uses. **Patches 1 and 2 are therefore unnecessary on 2.1.323 and later.** Verified on 2.1.323 and 2.1.325 with a CRLF file and a completely unpatched extension: the side-by-side diff tab opens correctly. (There is no 2.1.324; it was never released.)

The script detects this automatically. On 2.1.323 and later it reports:

```
  -> Extension handles CRLF itself via qq() (upstream fix, ext 2.1.323+).
  -> Patches 1 and 2 not needed; extension.js left unmodified.
```

and `extension.js` is not touched at all — not rewritten, and no `.bak` created for it. Only `webview/index.js` is modified, for Patch 3. On 2.1.322 and earlier, all three patches apply as before. The detection looks for the upstream wrapper itself rather than comparing version numbers, so it keeps working on future releases.

### Patch 3 may still be worth applying

Patch 3 is a separate problem and upstream has **not** changed it — the `IS_FULL_EDITOR` guards are still present and unchanged in 2.1.325.

The extension records, once, whether the chat panel occupies the main editing area. If the answer is yes it deliberately skips the diff tab and shows the inline diff in the chat instead, and it also leaves the diff tab's accept checkmarks unconnected. The trouble is that the answer is decided when the panel is created, then saved with the window state and handed back on every reload — it is never reconsidered. So if it ever lands on "yes" when it should be "no", it stays wrong, and every edit from then on skips the diff tab. Reloading does not clear it.

That failure has not recurred on 2.1.323 or 2.1.325 across a reload or a full restart — but its cause was never identified, so it cannot be called fixed. Patch 3 removes the guards entirely, so the stored answer stops mattering.

**If the diff tab opens normally for you, you don't need to run this script at all.** Run it if the diff tab stops opening and you get the inline diff in the chat instead.

## The Problem

The rest of this document describes the bugs as they were, and still are on extensions before 2.1.323. See the note above for what applies to current versions.

When Claude Code edits a file that uses Windows-style line endings (CRLF / `\r\n`), multi-line edits fail to open in the side-by-side diff preview tab. Instead, only a small inline diff appears in the chat window, with no surrounding context. Single-line edits work fine.

This affects:
- **Windows local sessions** — files with CRLF line endings
- **Remote SSH sessions** — when editing CRLF files on the remote server

## Root Cause

The Claude Code VS Code extension has a function that applies proposed edits to a copy of the file to generate the "after" side of a diff preview. When a file has CRLF (`\r\n`) line endings:

1. The file content is read with `\r\n` line endings
2. The edit's `oldString` (the text to find and replace) uses `\n` only
3. A multi-line `oldString` like `"seven\neight"` fails to match `"seven\r\neight"` in the file content
4. The function throws "String not found in file" internally
5. The extension silently falls back to inline display instead of the diff tab

Single-line edits aren't affected because the `oldString` has no newline characters to mismatch.

## Applying the Fix

### Run the Script on Windows

1. Save `patch_claude_crlf.js` anywhere on your Windows system.
2. Open a Windows Command Prompt and run: `node \path\to\patch_claude_crlf.js`.
   - The script will automatically find the newest Claude Code extension in the .vscode directory under your home directory.
   - You can also specify a path to the extension directory or the extension.js file: `node /path/to/patch_claude_crlf.js /path/to/extension-dir-or-file`.
   - The script should report "Patches applied successfully!"
3. Reload VS Code (`Ctrl+Shift+P` → "Developer: Reload Window").
4. Create a text file and type a few lines into it.
   - Verify it contains CRLFs by looking for the CRLF indicator in the lower right corner of VS Code while the file is in focus.
5. Ensure that Claude Code is in "Ask before edits" mode.
   - Then ask Claude to make an edit to the file by changing two consecutive lines.
   - Verify that the side-by-side diff tab opens as it should.

### Run the Script Again on the SSH Server (if VS Code connects to your files via SSH)
1. Save `patch_claude_crlf.js` anywhere on the system you connect to via SSH.
2. Open a command line on the SSH system and run: `node /path/to/patch_claude_crlf.js`.
   - The script will automatically find the newest Claude Code extension under `~/.vscode-server/extensions/`.
   - You can also specify a path to the extension directory or the extension.js file: `node /path/to/patch_claude_crlf.js /path/to/extension-dir-or-file`.
   - The script should report "Patches applied successfully!"
3. Reload VS Code (`Ctrl+Shift+P` → "Developer: Reload Window").
4. Copy the test file that you created in Windows to the SSH system, and keep the CRLFs in it.
5. Ensure that Claude Code is in "Ask before edits" mode.
   - Then ask Claude to make an edit to the file by changing two consecutive lines.
   - Verify that the side-by-side diff tab opens as it should.

## Re-applying After Extension Updates

When the Claude Code extension updates, both patched files (`extension.js` and `webview/index.js`) are replaced with new versions. You'll need to re-run the patch script. The `.bak` files from the previous version will not be overwritten.

## What's Being Patched

Three patches across two files in the extension directory:

### Patch 1 — Edit Function (CRLF normalization)

At the start of the edit-applying function, normalize all `\r\n` to `\n` in both the file content and the edit strings (oldString/newString) before attempting to match:

```js
// Before (minified, variable names vary by version):
function Fk(z,v){let j=z, ...

// After:
function Fk(z,v){
  z=z.replace(/\r\n/g,"\n");                    // normalize file content
  v=v.map(function(e){return{                    // normalize edit strings
    oldString:e.oldString.replace(/\r\n/g,"\n"),
    newString:e.newString.replace(/\r\n/g,"\n"),
    replaceAll:e.replaceAll
  }});
  let j=z, ...
```

**Why both?** On Windows local, the edit strings can contain `\r\n`. Via SSH, they typically already use `\n`, so the edit string normalization is a harmless no-op.

### Patch 2 — Diff Function (left-side temp file normalization)

The diff viewer shows the original file on the left and the proposed edit on the right. After Patch 1, the right side uses `\n` only. If the left side still has `\r\n`, the diff would show spurious line-ending differences on every line. This patch normalizes the left side too:

```js
// Before:
...createFile(K,"").uri}let W=Fk($ ...

// After:
...createFile(K,"").uri}
if($.includes("\r\n")){
  $=$.replace(/\r\n/g,"\n");
  G=v.createFile(K,$).uri   // re-create left temp file with normalized content
}
let W=Fk($ ...
```

### Patch 3 — Webview Permission Handler (IS_FULL_EDITOR bypass removal)

Starting in extension v2.1.59, the webview's permission handler skips opening the diff tab when `window.IS_FULL_EDITOR` is `true`, falling back to inline accept/reject in the chat. This was intended to differentiate between editor-tab mode and sidebar mode, but the `IS_FULL_EDITOR` flag is set incorrectly during panel deserialization — VS Code reports the wrong `viewColumn` before the layout is finalized, so the Claude panel in the second tab group is misidentified as being in the first group.

This patch removes the `IS_FULL_EDITOR` guards from `webview/index.js`, restoring the diff tab behavior. They appear in two shapes, in two different places:

**Standalone form (ext v2.1.59 onward, still present in 2.1.319):** the check is its own `if`/`return` in the permission handler, once per tool handler (Edit, Write). It controls whether the diff tab opens at all. The patch deletes the whole statement.

```js
// Before:
if($.toolName===EditTool.toolName){
  if(window.IS_FULL_EDITOR)return;    // <-- skips diff tab
  let Z=new AbortController;
  ...
  let X=await J.openDiff(...);

// After:
if($.toolName===EditTool.toolName){
  let Z=new AbortController;
  ...
  let X=await J.openDiff(...);
```

**Compound form (present in at least 2.1.314 and 2.1.319; earlier bound not established):** in a separate helper that covers both tools and decides how an accept is routed, the `IS_FULL_EDITOR` check is folded into a larger disjunction alongside other guards. The patch strips just the `IS_FULL_EDITOR` disjunct and its adjacent `||`, leaving the other guards intact.

```js
// Before:
if(window.IS_FULL_EDITOR||!t.acceptDiff||y!==null)return;

// After:
if(!t.acceptDiff||y!==null)return;
```

Both forms coexist in the same version — 2.1.314 and 2.1.319 each have two standalone instances alongside one compound instance — so the script applies both sets of patterns in a single run.

The two shapes are not duplicates of each other; they gate different things, and stripping only one leaves half the behavior broken:

- The **standalone** guards decide whether the diff tab opens. With them in place, the edit falls back to inline accept/reject in the chat and no tab appears.
- The **compound** guard decides how an accept is routed. The helper returns the file path only when every disjunct passes; the caller then wires up `acceptDiff`. When the helper returns early, the caller falls through to `e.accept(y||e.inputs)` — plain inline accept — so the diff tab's ✓ and the per-hunk ✓ have nothing behind them and acceptance only works from the chat panel.

The extension's output channel distinguishes the two routes. With the compound guard still active, accepting logs `diff_accepted_from_panel` and `accept_diff from panel ... found: true`. With it stripped, accepting from the tab logs `hunk_accepted <uri> line N` and `diff_accepted` with no panel lines.

Because the standalone pattern alone was matching 0 occurrences in 2.1.314 and 2.1.319 once the standalone guards were gone, earlier versions of the script reported "Patch 3 appears to be already applied" while the compound guard was still active. If in-tab accept does not work, re-run the script and check the reported count rather than trusting the already-applied message.

## How the Patch Script Works

Since `extension.js` is minified with different variable names in each version, the script finds the right functions by **content signatures** — unique strings and structural patterns that don't change across versions:

### Finding the Edit Function
- **Regex pattern:** `function XX(a,b){let c=a,d=[];if(!a` — a function taking two params where the first is immediately assigned to a local variable, followed by an empty array
- **Verification:** Checks that the function body contains the unique error messages `"String not found in file. Failed to apply edit."` and `"Original and edited file match exactly"` — these are user-facing strings that don't get minified
- **Variable extraction:** The regex captures the function name and parameter names, which are used to construct the patch with the correct variable names for that version

### Finding the Diff Patch Point
- **Anchor string:** `"leftTempFileProvider.createFile"` — a log message in the diff function's catch block
- **Context matching:** From that anchor, matches through to the end of the catch block: the log string, anything up to the end of the `info()` call, then `LEFTURIVAR=PROVIDER.createFile(PATHVAR,<anything>).uri}`. That one pattern covers both shapes seen so far — `createFile(r,"")` up to 2.1.314 and `createFile(r,b)` from 2.1.319 — and yields the left-side URI, temp file provider, and file path variable names. The CRLF check is inserted at the closing `}`.
- **Content variable:** Read from the statement immediately after the catch block, which passes the left-side content to the edit function: `let X=EDITFUNC(CONTENTVAR,EDITSVAR)`. The edit function's name is already known from Patch 1. This is the variable the diff's right-hand side is built from, so it is the one that has to be normalized.

Earlier versions of the script found the content variable by looking backwards for `let URIVAR=XX.Uri.file(PATHVAR),CONTENTVAR=""`. That broke in 2.1.319, which moved both variables into the middle of a longer declaration list so nothing was preceded by `let`. Reading the variable from the edit-function call does not depend on where it was declared.

### Gotcha: `$` as a Variable or Function Name
The minifier sometimes uses `$` in identifiers — as a standalone variable (the file content variable in the diff function), as a leading character in a function name (the edit function was renamed from `fc` to `$c` in 2.1.121), as a function parameter name (`function oz0($,Q)` in 2.1.251), and inside module aliases (`v$.Uri.file` in 2.1.251). In JavaScript regex, `\w` does **not** match `$`, so the script uses `[\w$]+` for **every** identifier it captures. This tripped us up repeatedly: 2.1.71 (content var `$`) → 2.1.72 (`Z`) → 2.1.73 (`$`), again at 2.1.121 when the edit function name became `$c`, and again at 2.1.251 when parameter names and module aliases picked up `$`. The remaining `\w+` captures were all widened in script version 2.0.2, so this class of breakage should not recur.

### Gotcha: `$` in the Replacement String
`String.prototype.replace()` treats `$&`, `` $` ``, `$'`, `$$`, and `$1` in the *replacement string* as special patterns. Since the generated patch code now routinely contains `$` (e.g. `$=$.replace(/\r\n/g,"\n")`), the script builds Patch 1 with a replacer **function** rather than a replacement string. Patch 2 is spliced in at an explicit byte index instead of using `replace()` at all — the anchor text is not necessarily unique in the file (`extension.js` contains a second, unrelated diff function that can minify to the same text), so a plain `replace()` could patch the wrong site.

### Finding the IS_FULL_EDITOR Checks (Patch 3)
- **File:** `webview/index.js` in the extension directory
- **Patterns:**
  - Standalone: `if(window.IS_FULL_EDITOR)return;` → removed entirely
  - Compound (leading): `(window.IS_FULL_EDITOR||` → `(`
  - Compound (middle): `||window.IS_FULL_EDITOR||` → `||`
  - Compound (trailing): `||window.IS_FULL_EDITOR)` → `)`
- **Why paren-anchored for the compound forms:** `IS_FULL_EDITOR` is also used legitimately in CSS class ternaries (`window.IS_FULL_EDITOR?cls:""`), conditional rendering (`!window.IS_FULL_EDITOR&&...`), and session state (`isFullEditor:window.IS_FULL_EDITOR`). Anchoring on `(` and `)` matches only the guard disjunction and leaves these intact.
- **Action:** All four patterns are applied globally in a single run — in both 2.1.314 and 2.1.319 the script removes 2 standalone + 1 compound = 3 occurrences, out of 9 total `window.IS_FULL_EDITOR` uses
- **Detection:** If no patterns match, assumes already patched. This is an absence-of-match test, not a check that the guards are gone, so a future version using a shape none of the four patterns cover would again be reported as already patched while its guard stayed active.

### Safety Features
- Creates `.bak` backups for both `extension.js` and `webview/index.js` before modifying
- Idempotent — detects and skips already-applied patches
- Validates output bytes to ensure `\r\n` was written as escape sequences (`\x5c\x72\x5c\x6e`) not raw CR/LF bytes (`\x0d\x0a`)

## Notes

- Patches 1 & 2 (CRLF) were developed and tested on extension versions 2.1.56 through 2.1.319.
- Patch 3 (IS_FULL_EDITOR) was developed and tested on extension versions 2.1.59 through 2.1.319. It is not needed on versions before 2.1.59 since the IS_FULL_EDITOR check did not exist yet.
- Breakages up to and including 2.1.251 were all in the script's regexes rather than the extension's logic. 2.1.319 was the first one where the diff function itself changed. When a run fails, check for a new identifier shape first, then for a changed statement shape around the anchor.
- **2.1.319 added a path check that can change what the left side of the diff contains.** Before opening the diff, the extension calls `VPe`, which walks the file's path with `lstat`, `opendirNofollow` and `readlink` looking for anything that may lead off the machine — network mounts, UNC or WSL paths, symlinks leaving the tree, unreadable ancestry. The open workspace folders are passed in as the `anchor`: trusted roots that let the walk short-circuit. They are **not** a containment boundary, so an ordinary local file outside the workspace still passes. When the check does fail, the extension throws `"Not opened: the path may lead to another machine"`, appends `(file not read)` to the diff tab title, and builds the left side from the edit's `oldString` values joined with newlines rather than from the file on disk. The diff tab still opens, but the left side is not the real file. This is upstream behavior, not something the patch changes. If a diff's left side looks wrong, check the tab title for `(file not read)` first.
- All patches tested on both Windows and Linux (Remote SSH).
- The underlying bug should ideally be fixed in the extension itself. Consider upvoting or commenting on the relevant issue at https://github.com/anthropics/claude-code/issues if one exists.
- The patch only modifies the side-by-side diff preview mechanism. It does not affect how edits are actually applied to files.
