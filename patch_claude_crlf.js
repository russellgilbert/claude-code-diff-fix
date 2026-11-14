#!/usr/bin/env node
/**
 * Claude Code CRLF Patch Script
 *
 * Fixes a bug where multi-line edits on files with CRLF line endings
 * show inline in the chat instead of opening the side-by-side diff tab.
 *
 * Root cause: The extension's edit-applying function receives file content
 * with \r\n but the edit strings (oldString/newString) use \n only,
 * causing a "String not found in file" error that silently falls back
 * to inline display.
 *
 * This script applies three patches:
 *   1. Edit function (extension.js): normalizes \r\n to \n in both file content and edit strings
 *   2. Diff function (extension.js): normalizes \r\n in the left-side temp file content
 *   3. Webview permission handler (webview/index.js): removes IS_FULL_EDITOR check
 *      that prevents the diff tab from opening when Claude runs in an editor tab
 *
 * The patches are found by content signatures, not variable names,
 * so this works across minified versions with different variable names.
 *
 * Usage: node patch_claude_crlf.js [path-to-extension-dir-or-file]
 *   Accepts a path to extension.js or to the extension directory.
 *   If no path given, auto-detects the newest Claude Code extension.
 *
 * Version History:
 *   1.0.0 - Initial release. Worked for extension versions up to 2.1.71.
 *
 *   1.0.1 - Fixed compatibility with extension versions where the content
 *           variable in the diff function is not named '$'. In 2.1.71 the
 *           variable was '$' (hardcoded in v1.0.0). In 2.1.72 it changed to
 *           'Z', breaking the patch. In 2.1.73 it reverted to '$'. The fix
 *           was to dynamically capture the variable name using ([\w$]+)
 *           instead of a hardcoded \$ in the regex — note that '$' is a valid
 *           JS identifier but is not matched by \w in regex.
 *
 *   1.0.2 - Accept a directory path as argument (auto-appends extension.js).
 *           Also extracts version number from path for better logging.
 *           Verified working on 2.1.75 and 2.1.76.
 *
 *   2.0.0 - Added Patch 3: removes if(window.IS_FULL_EDITOR)return; from the
 *           webview permission handler in webview/index.js. This check was added
 *           in extension v2.1.59 and prevents the diff tab from opening when
 *           Claude runs in an editor tab (vs sidebar). The IS_FULL_EDITOR flag
 *           is also set incorrectly during panel deserialization due to a VS Code
 *           timing issue where viewColumn is not yet finalized.
 *           Verified working on 2.1.56 through 2.1.92.
 *
 *   2.0.1 - Allow '$' in the edit function name. In 2.1.121 the minifier renamed
 *           the edit function to '$c', and \w in regex doesn't match '$', so the
 *           findEditFunction regexes failed. Changed the function-name capture
 *           groups from (\w+) to ([\w$]+) (the same fix already applied earlier
 *           to the content-var capture in findDiffPatchPoint). Verified working
 *           on 2.1.121, 2.1.122, and 2.1.123.
 *
 *   2.0.2 - Allow '$' in every identifier the script captures, not just the two
 *           spots fixed in 1.0.1 and 2.0.1. In 2.1.251 the minifier started using
 *           '$' as a function parameter name (function oz0($,Q)) and inside module
 *           aliases (v$.Uri.file), so both findEditFunction and findDiffPatchPoint
 *           failed with "Could not locate the edit function". All (\w+) captures
 *           are now ([\w$]+).
 *           Also stopped writing the patches with String.replace() replacement
 *           strings, where a '$' in the generated code would be treated as a
 *           special pattern ($&, $`, $', $$, $1). Patch 1 now uses a replacer
 *           function; Patch 2 is spliced in at the exact index found, which also
 *           fixes it targeting the wrong site if its anchor text is not unique.
 *           The three patch sites themselves are unchanged in 2.1.251.
 *           Verified working on 2.1.241 and 2.1.251.
 *
 *   2.1.0 - Rewrote findDiffPatchPoint for 2.1.319, where the diff function
 *           actually changed rather than just being renamed. Two breakages:
 *           the catch block that logs 'leftTempFileProvider.createFile' now
 *           reads createFile(PATH,CONTENTVAR) instead of createFile(PATH,""),
 *           and the left-side URI and content variables moved from their own
 *           'let URIVAR=X.Uri.file(PATH),CONTENTVAR=""' statement into the
 *           middle of a longer declaration list, so the old 'let ' anchor no
 *           longer applied.
 *           The function now anchors on the log string itself and reads the
 *           content variable from the edit-function call that immediately
 *           follows the catch block, which is the variable the diff's
 *           right-hand side is actually built from. Patch 2 is unchanged.
 *           Verified working on 2.1.314 (old shape) and 2.1.319 (new shape).
 *
 *   2.1.1 - Extended Patch 3 for 2.1.319, where the standalone guard
 *           if(window.IS_FULL_EDITOR)return; was folded into a compound
 *           disjunction, e.g. if(window.IS_FULL_EDITOR||!t.acceptDiff||y!==null)return;.
 *           The old regex matched 0 occurrences and reported "already applied"
 *           while the guard was still active. Patch 3 now also strips the
 *           IS_FULL_EDITOR disjunct from compound checks (leading, middle, or
 *           trailing position), keeping the other legitimate IS_FULL_EDITOR
 *           uses (CSS class toggles, conditional rendering) intact.
 *           Verified working on 2.1.319.
 *
 *   2.2.0 - Extension 2.1.323 fixed the CRLF bug upstream, so Patches 1 and 2
 *           are obsolete from that version on. The diff function now calls a
 *           CRLF-aware wrapper instead of the edit function directly; the
 *           wrapper normalizes content and oldStrings, applies the edits, then
 *           restores CRLF when the file is majority-CRLF.
 *           The script now detects that wrapper and, when it is present, skips
 *           Patches 1 and 2 and leaves extension.js completely unmodified (no
 *           rewrite, no .bak). Only webview/index.js is touched, for Patch 3.
 *           Failing to locate the diff patch point is no longer fatal either:
 *           it warns and continues to Patch 3, which is the patch that is still
 *           relevant on current versions.
 *           extension.js is now written only when a patch actually changed it,
 *           rather than unconditionally rewritten on every run.
 *           Verified on 2.1.323 and 2.1.325 (upstream wrapper present, Patches
 *           1 and 2 skipped, extension.js left byte-identical to stock) and on
 *           2.1.314 and 2.1.322 (old shape, all three applied, extension.js
 *           byte-identical to the previously verified patch output).
 *           Note there is no 2.1.324; it was never released.
 */

const fs = require('fs');
const path = require('path');

// --- Helpers ---
const B = String.fromCharCode(92); // backslash - avoids escaping issues
const RN_REGEX = '/' + B + 'r' + B + 'n/g';
const N_STR = '"' + B + 'n"';

function findExtensionJs() {
  // Try common VS Code extension locations
  const home = process.env.HOME || process.env.USERPROFILE;
  const extDirs = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
  ];

  let candidates = [];
  for (const extDir of extDirs) {
    if (!fs.existsSync(extDir)) continue;
    const entries = fs.readdirSync(extDir).filter(e => e.startsWith('anthropic.claude-code-'));
    for (const entry of entries) {
      const jsPath = path.join(extDir, entry, 'extension.js');
      if (fs.existsSync(jsPath)) {
        // Extract version number for sorting
        const verMatch = entry.match(/(\d+\.\d+\.\d+)/);
        const ver = verMatch ? verMatch[1] : '0.0.0';
        candidates.push({ path: jsPath, version: ver, dir: path.join(extDir, entry) });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Sort by version descending, pick newest
  candidates.sort((a, b) => {
    const av = a.version.split('.').map(Number);
    const bv = b.version.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (av[i] !== bv[i]) return bv[i] - av[i];
    }
    return 0;
  });

  return candidates[0];
}

function findEditFunction(content) {
  // The edit function has this structure:
  //   function XX(a,b){let c=a,d=[];if(!a&&b.length===1&&b[0]&&b[0].oldString===""...
  // It contains unique error messages we can use to verify.
  const match = content.match(/function\s+([\w$]+)\(([\w$]+),([\w$]+)\)\{let\s+([\w$]+)=\2,[\w$]+=\[\];if\(!\2/);
  if (match) {
    const funcName = match[1];
    const param1 = match[2];
    const param2 = match[3];
    const fullMatch = match[0];
    const funcStart = content.indexOf(fullMatch);
    const searchArea = content.substring(funcStart, funcStart + 2000);
    if (searchArea.includes('String not found in file. Failed to apply edit.') &&
        searchArea.includes('Original and edited file match exactly')) {
      return { funcName, param1, param2, fullMatch, index: funcStart, alreadyPatched: false };
    }
  }

  // Try matching already-patched version: function XX(a,b){a=a.replace(...)...let c=a,
  const patchedMatch = content.match(/function\s+([\w$]+)\(([\w$]+),([\w$]+)\)\{\2=\2\.replace\(/);
  if (patchedMatch) {
    const funcName = patchedMatch[1];
    const param1 = patchedMatch[2];
    const param2 = patchedMatch[3];
    const funcStart = content.indexOf(patchedMatch[0]);
    const searchArea = content.substring(funcStart, funcStart + 2000);
    if (searchArea.includes('String not found in file. Failed to apply edit.') &&
        searchArea.includes('Original and edited file match exactly')) {
      return { funcName, param1, param2, fullMatch: patchedMatch[0], index: funcStart, alreadyPatched: true };
    }
  }

  return null;
}

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Extension 2.1.323 fixed the CRLF bug upstream by wrapping the edit function in
// a line-ending-aware helper. The diff function now calls the wrapper instead of
// the edit function directly:
//   function qq(e,t){if(!e.includes(`\r\n`)||!yN(t))return hIe(e,t);
//     let n=hIe(_N(e),t.map((i)=>({...i,oldString:_N(i.oldString)}))),...
//     return o>s?hN(n,`\r\n`):n}
// It normalizes content and oldStrings, applies the edits, then restores CRLF
// when the file is majority-CRLF. That is exactly what Patches 1 and 2 did, so
// on those versions both are skipped and extension.js is left untouched.
//
// Returns true when funcName names a wrapper that handles \r\n itself.
function isCrlfAwareWrapper(content, funcName, editFuncName) {
  if (funcName === editFuncName) return false;
  const declIdx = content.search(new RegExp('function\\s+' + reEscape(funcName) + '\\('));
  if (declIdx === -1) return false;
  const body = content.substring(declIdx, declIdx + 600);
  // Must mention a carriage return AND delegate to the edit function.
  return body.includes(B + 'r') && body.includes(editFuncName + '(');
}

function findDiffPatchPoint(content, editFuncName) {
  // The diff function logs 'leftTempFileProvider.createFile' in the catch block
  // that handles a file it could not open. The CRLF check goes in immediately
  // after that catch block closes, before the content is handed to the edit
  // function to build the right-hand side of the diff.
  //
  // Up to 2.1.314 the catch block ended with the file path and an empty string:
  //   ...info("leftTempFileProvider.createFile",r),S=t.createFile(r,"").uri}
  // In 2.1.319 the log call gained a third argument and the createFile call
  // takes the content variable instead of "":
  //   ...info("leftTempFileProvider.createFile",r,String(j)),m=t.createFile(r,b).uri}
  // One pattern covers both: the log string, then anything up to the end of the
  // info() call, then LEFTURIVAR=PROVIDER.createFile(PATHVAR,<anything>).uri}
  const ltfpIdx = content.indexOf('leftTempFileProvider.createFile');
  if (ltfpIdx === -1) return null;

  const searchArea = content.substring(ltfpIdx, ltfpIdx + 300);
  const catchEndMatch = searchArea.match(
    /leftTempFileProvider\.createFile"[^{}]{0,80}?\),([\w$]+)=([\w$]+)\.createFile\(([\w$]+),[^)]{0,20}\)\.uri\}/
  );
  if (!catchEndMatch) return null;

  const leftUriVar = catchEndMatch[1];  // S in 2.1.314, m in 2.1.319
  const providerVar = catchEndMatch[2]; // t in both
  const filePathVar = catchEndMatch[3]; // r in both

  const insertAfter = catchEndMatch[0];
  const insertAfterIdx = ltfpIdx + searchArea.indexOf(insertAfter);
  const insertEnd = insertAfterIdx + insertAfter.length;
  const tail = content.substring(insertEnd, insertEnd + 200);

  // Already patched? The inserted block is the next thing after the catch:
  //   if(CONTENTVAR.includes("\r\n")){...}
  const appliedMatch = tail.match(/^if\(([\w$]+)\.includes\(/);
  if (appliedMatch) {
    const cv = appliedMatch[1];
    if (tail.startsWith('if(' + cv + '.includes("' + B + 'r' + B + 'n")){')) {
      return {
        filePathVar, leftUriVar, contentVar: cv, providerVar,
        insertAfter, insertAfterIdx, insertEnd, alreadyApplied: true
      };
    }
    return null;
  }

  // Not patched: shortly after the catch block, the left-side content is handed
  // to the edit function (or, from 2.1.323, to a CRLF-aware wrapper around it).
  // That call names the variable we have to normalize. Taking it from here
  // rather than from the earlier CONTENTVAR="" declaration means we normalize
  // exactly what the diff's right-hand side is built from, and it does not care
  // where in the declaration list that variable was introduced.
  //
  //   2.1.319:  }let S=XPe(b,i),E=JPe(i),...
  //   2.1.325:  }let S,b=o,C;try{S=qq(E,s)}catch(G){...
  //
  // So match the first =CALLEE(CONTENTVAR,EDITSVAR) in the tail rather than
  // insisting the call be the first statement.
  const callMatch = tail.match(/=([\w$]+)\(([\w$]+),([\w$]+)\)/);
  if (!callMatch) return null;

  const calleeName = callMatch[1];

  // If the callee is not the edit function itself, it may be the upstream
  // CRLF-aware wrapper added in 2.1.323, in which case Patches 1 and 2 are
  // obsolete and extension.js should be left alone.
  if (isCrlfAwareWrapper(content, calleeName, editFuncName)) {
    return {
      filePathVar, leftUriVar, contentVar: callMatch[2], providerVar,
      insertAfter, insertAfterIdx, insertEnd,
      alreadyApplied: false, upstreamHandlesCrlf: true, wrapperName: calleeName
    };
  }

  // Anything else calling into this position is a shape we have not seen; bail
  // rather than insert normalization in front of code we do not understand.
  if (calleeName !== editFuncName) return null;

  return {
    filePathVar,
    leftUriVar,
    contentVar: callMatch[2],
    providerVar,
    insertAfter,
    insertAfterIdx,
    insertEnd,
    alreadyApplied: false,
    upstreamHandlesCrlf: false
  };
}

// --- Main ---
let targetPath = process.argv[2];
let info;

if (targetPath) {
  // If a directory was given, look for extension.js inside it
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
    const jsInDir = path.join(targetPath, 'extension.js');
    if (fs.existsSync(jsInDir)) {
      targetPath = jsInDir;
    } else {
      console.error('Error: No extension.js found in directory:', targetPath);
      process.exit(1);
    }
  }
  if (!fs.existsSync(targetPath)) {
    console.error('Error: File not found:', targetPath);
    process.exit(1);
  }
  const verMatch = targetPath.match(/(\d+\.\d+\.\d+)/);
  info = { path: targetPath, version: verMatch ? verMatch[1] : 'unknown', dir: path.dirname(targetPath) };
} else {
  info = findExtensionJs();
  if (!info) {
    console.error('Error: Could not find Claude Code extension.js');
    console.error('Please provide the path as an argument: node patch_claude_crlf.js /path/to/extension.js');
    process.exit(1);
  }
}

console.log('Found extension:', info.dir);
console.log('Version:', info.version);
console.log('File:', info.path);
console.log();

let content = fs.readFileSync(info.path, 'utf8');

// Check if already patched (look for our CRLF normalization pattern near the edit function)
const editFunc = findEditFunction(content);
if (!editFunc) {
  console.error('Error: Could not locate the edit function in extension.js');
  console.error('The file structure may have changed. Manual patching may be needed.');
  process.exit(1);
}

console.log('Found edit function:', editFunc.funcName + '(' + editFunc.param1 + ',' + editFunc.param2 + ')');

// Probe the diff patch point before changing anything. This is read-only: it
// tells us whether this extension already handles CRLF itself (2.1.323+), in
// which case Patches 1 and 2 are obsolete and extension.js is left untouched.
// The offsets it returns are NOT used for the splice -- Patch 1 inserts text
// earlier in the file and shifts them -- so Patch 2 re-finds the point against
// the updated content below.
const diffPoint = findDiffPatchPoint(content, editFunc.funcName);
if (!diffPoint) {
  console.error('Error: Could not locate the diff function patch point');
  console.error('The file structure may have changed. Manual patching may be needed.');
  console.error('Patch 3 (webview) will still be attempted.');
}

const skipCrlfPatches = !diffPoint || diffPoint.upstreamHandlesCrlf;
let extensionChanged = false;

if (diffPoint && diffPoint.upstreamHandlesCrlf) {
  console.log('  -> Extension handles CRLF itself via ' + diffPoint.wrapperName +
              '() (upstream fix, ext 2.1.323+).');
  console.log('  -> Patches 1 and 2 not needed; extension.js left unmodified.');
}

// --- Patch 1 ---
if (skipCrlfPatches) {
  // nothing to do
} else if (editFunc.alreadyPatched) {
  console.log('  -> Patch 1 (edit function CRLF) appears to be already applied, skipping.');
} else {
  // Build patch 1
  const p1 = editFunc.param1;
  const p2 = editFunc.param2;
  const normalize_edits = p2 + '=' + p2 + '.map(function(e){return{oldString:e.oldString.replace(' + RN_REGEX + ',' + N_STR + '),newString:e.newString.replace(' + RN_REGEX + ',' + N_STR + '),replaceAll:e.replaceAll}});';
  const normalize_content = p1 + '=' + p1 + '.replace(' + RN_REGEX + ',' + N_STR + ');';

  const oldStr = editFunc.fullMatch;
  const funcDecl = 'function ' + editFunc.funcName + '(' + p1 + ',' + p2 + '){';
  const newStr = funcDecl + normalize_content + normalize_edits + 'let ' + oldStr.split('let ')[1];

  if (!content.includes(oldStr)) {
    console.error('Error: Could not find exact edit function pattern to replace');
    process.exit(1);
  }

  // Replacer function, not a replacement string: newStr can contain '$' (the
  // minifier uses it as an identifier), and $&, $`, $', $$, $1 would be substituted.
  content = content.replace(oldStr, function () { return newStr; });
  extensionChanged = true;
  console.log('  -> Patch 1 applied: CRLF normalization in edit function');
}

// --- Patch 2 ---
if (!skipCrlfPatches) {
  // Re-find against the current content. Patch 1 inserted text earlier in the
  // file, so the offsets from the probe above are stale by exactly that length.
  const dp = findDiffPatchPoint(content, editFunc.funcName);
  if (!dp) {
    console.error('Error: Diff patch point went missing after Patch 1 was applied');
    process.exit(1);
  }

  console.log('Found diff patch point: ' + dp.insertAfter);
  console.log('  URI var:', dp.leftUriVar, ' Provider var:', dp.providerVar,
              ' Path var:', dp.filePathVar, ' Content var:', dp.contentVar);

  if (dp.alreadyApplied) {
    console.log('  -> Patch 2 (diff left-side CRLF) appears to be already applied, skipping.');
  } else {
    const cv = dp.contentVar;
    const crlf_check = 'if(' + cv + '.includes("' + B + 'r' + B + 'n")){' + cv + '=' + cv + '.replace(' + RN_REGEX + ',' + N_STR + ');' + dp.leftUriVar + '=' + dp.providerVar + '.createFile(' + dp.filePathVar + ',' + cv + ').uri}';

    // Splice at the exact index found. The insertAfter string is not unique in the
    // file (a second diff function later on can produce the same minified text),
    // so a plain content.replace() could patch the wrong site.
    content = content.slice(0, dp.insertEnd) + crlf_check + content.slice(dp.insertEnd);
    extensionChanged = true;
    console.log('  -> Patch 2 applied: CRLF normalization in diff left-side');
  }
}

// Backup and write extension.js only when something in it actually changed.
// On 2.1.323+ nothing does, so the file is left stock and no .bak is created
// for a file we never touched.
if (!extensionChanged) {
  console.log('\nextension.js unchanged, not rewritten.');
} else {
  const bakPath = info.path + '.bak';
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(info.path, bakPath);
    console.log('\nBackup saved to:', bakPath);
  } else {
    console.log('\nBackup already exists at:', bakPath);
  }

  fs.writeFileSync(info.path, content);

  // Verify the patches by checking raw bytes
  const written = fs.readFileSync(info.path);
  const fkIdx = written.indexOf(Buffer.from('function ' + editFunc.funcName + '('));
  const patchBytes = written.slice(fkIdx + 20, fkIdx + 60).toString('hex');
  if (patchBytes.includes('0d0a')) {
    console.error('\nWARNING: Detected raw CR/LF bytes in patch area!');
    console.error('The patch may have incorrect escape sequences.');
    console.error('Hex:', patchBytes);
    process.exit(1);
  }
}

// --- Patch 3: Remove IS_FULL_EDITOR check from webview/index.js ---
const webviewPath = path.join(info.dir, 'webview', 'index.js');
const webviewBakPath = webviewPath + '.bak';

if (fs.existsSync(webviewPath)) {
  let webviewContent = fs.readFileSync(webviewPath, 'utf8');
  // In <=2.1.313 the guard was the standalone form if(window.IS_FULL_EDITOR)return;.
  // In 2.1.319 it was folded into a compound disjunction in the same return-early
  // check, e.g. if(window.IS_FULL_EDITOR||!t.acceptDiff||y!==null)return;. We strip
  // just the IS_FULL_EDITOR disjunct and its adjacent `||`, anchored on the enclosing
  // parens so we don't touch the other legitimate IS_FULL_EDITOR uses (CSS class
  // toggles, conditional rendering, session state).
  const patterns = [
    [/\(window\.IS_FULL_EDITOR\|\|/g, '('],          // leading disjunct
    [/\|\|window\.IS_FULL_EDITOR\|\|/g, '||'],        // middle disjunct
    [/\|\|window\.IS_FULL_EDITOR\)/g, ')'],           // trailing disjunct
    [/if\(window\.IS_FULL_EDITOR\)return;/g, ''],    // standalone (old form)
  ];

  let totalMatches = 0;
  for (const [re, repl] of patterns) {
    const m = webviewContent.match(re);
    if (m) {
      totalMatches += m.length;
      webviewContent = webviewContent.replace(re, repl);
    }
  }

  if (totalMatches > 0) {
    if (!fs.existsSync(webviewBakPath)) {
      fs.copyFileSync(webviewPath, webviewBakPath);
      console.log('Webview backup saved to:', webviewBakPath);
    } else {
      console.log('Webview backup already exists at:', webviewBakPath);
    }

    fs.writeFileSync(webviewPath, webviewContent);
    console.log('  -> Patch 3 applied: removed ' + totalMatches + ' IS_FULL_EDITOR check(s) from webview/index.js');
  } else {
    console.log('  -> Patch 3 (IS_FULL_EDITOR) appears to be already applied, skipping.');
  }
} else {
  console.log('  -> Patch 3 skipped: webview/index.js not found (may be a different extension layout)');
}

console.log('\nAll patches applied successfully!');
console.log('Please reload VS Code (Ctrl+Shift+P -> "Developer: Reload Window") for changes to take effect.');
