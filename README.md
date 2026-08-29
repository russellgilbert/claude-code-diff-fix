# Claude Code CRLF Diff Bug — Fix Instructions

## The Problem

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

This patch removes the `if(window.IS_FULL_EDITOR)return;` checks from the permission handler in `webview/index.js`, restoring the diff tab behavior:

```js
// Before (in webview/index.js permission handler):
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

The same removal is applied to both the Edit tool and Write tool handlers.

## How the Patch Script Works

Since `extension.js` is minified with different variable names in each version, the script finds the right functions by **content signatures** — unique strings and structural patterns that don't change across versions:

### Finding the Edit Function
- **Regex pattern:** `function XX(a,b){let c=a,d=[];if(!a` — a function taking two params where the first is immediately assigned to a local variable, followed by an empty array
- **Verification:** Checks that the function body contains the unique error messages `"String not found in file. Failed to apply edit."` and `"Original and edited file match exactly"` — these are user-facing strings that don't get minified
- **Variable extraction:** The regex captures the function name and parameter names, which are used to construct the patch with the correct variable names for that version

### Finding the Diff Patch Point
- **Anchor string:** `"leftTempFileProvider.createFile"` — a unique log message in the diff function's catch block
- **Context matching:** From that anchor, finds the `createFile(VAR,"").uri}` pattern that ends the catch block — this is where the CRLF check is inserted
- **Variable discovery:** Looks backwards for `let URIVAR=XX.Uri.file(PATHVAR),$=""` to find the variable names for the left-side URI, the temp file provider, and the file path — these are used to construct the correct `G=v.createFile(K,$).uri` call for that version

### Gotcha: `$` as a Variable or Function Name
The minifier sometimes uses `$` in identifiers — as a standalone variable (the file content variable in the diff function), as a leading character in a function name (the edit function was renamed from `fc` to `$c` in 2.1.121), as a function parameter name (`function oz0($,Q)` in 2.1.251), and inside module aliases (`v$.Uri.file` in 2.1.251). In JavaScript regex, `\w` does **not** match `$`, so the script uses `[\w$]+` for **every** identifier it captures. This tripped us up repeatedly: 2.1.71 (content var `$`) → 2.1.72 (`Z`) → 2.1.73 (`$`), again at 2.1.121 when the edit function name became `$c`, and again at 2.1.251 when parameter names and module aliases picked up `$`. The remaining `\w+` captures were all widened in script version 2.0.2, so this class of breakage should not recur.

### Gotcha: `$` in the Replacement String
`String.prototype.replace()` treats `$&`, `` $` ``, `$'`, `$$`, and `$1` in the *replacement string* as special patterns. Since the generated patch code now routinely contains `$` (e.g. `$=$.replace(/\r\n/g,"\n")`), the script builds Patch 1 with a replacer **function** rather than a replacement string. Patch 2 is spliced in at an explicit byte index instead of using `replace()` at all — the `createFile(X,"").uri}` anchor is not unique in the file (a second, unrelated diff function later in `extension.js` can minify to the same text), so a plain `replace()` could patch the wrong site.

### Finding the IS_FULL_EDITOR Checks (Patch 3)
- **File:** `webview/index.js` in the extension directory
- **Pattern:** Literal string `if(window.IS_FULL_EDITOR)return;`
- **Action:** Global removal — all occurrences are deleted (typically 2: one for Edit tool, one for Write tool)
- **Detection:** If the pattern is not found, assumes already patched

### Safety Features
- Creates `.bak` backups for both `extension.js` and `webview/index.js` before modifying
- Idempotent — detects and skips already-applied patches
- Validates output bytes to ensure `\r\n` was written as escape sequences (`\x5c\x72\x5c\x6e`) not raw CR/LF bytes (`\x0d\x0a`)

## Notes

- Patches 1 & 2 (CRLF) were developed and tested on extension versions 2.1.56 through 2.1.251.
- Patch 3 (IS_FULL_EDITOR) was developed and tested on extension versions 2.1.59 through 2.1.251. It is not needed on versions before 2.1.59 since the IS_FULL_EDITOR check did not exist yet.
- All three patch sites are structurally unchanged through 2.1.251. Every breakage so far has been in the script's regexes, not in the extension's logic — when the script reports "Could not locate the edit function", check for a new identifier shape before assuming the extension was rewritten.
- All patches tested on both Windows and Linux (Remote SSH).
- The underlying bug should ideally be fixed in the extension itself. Consider upvoting or commenting on the relevant issue at https://github.com/anthropics/claude-code/issues if one exists.
- The patch only modifies the side-by-side diff preview mechanism. It does not affect how edits are actually applied to files.
