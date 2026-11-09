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

  // Not patched: the next statement passes the left-side content to the edit
  // function, which names the variable we have to normalize. Taking it from
  // here rather than from the earlier CONTENTVAR="" declaration means we
  // normalize exactly what the diff's right-hand side is built from, and it
  // does not care where in the declaration list that variable was introduced
  // (2.1.319 moved it out of a 'let URIVAR=...,CONTENTVAR=""' pair).
  const callMatch = tail.match(
    new RegExp('^let\\s+[\\w$]+=' + reEscape(editFuncName) + '\\(([\\w$]+),([\\w$]+)\\)')
  );
  if (!callMatch) return null;

  return {
    filePathVar,
    leftUriVar,
    contentVar: callMatch[1],
    providerVar,
    insertAfter,
    insertAfterIdx,
    insertEnd,
    alreadyApplied: false
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

// Check if patch 1 is already applied
if (editFunc.alreadyPatched) {
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
  console.log('  -> Patch 1 applied: CRLF normalization in edit function');
}

// Find and apply patch 2
const diffPoint = findDiffPatchPoint(content, editFunc.funcName);
if (!diffPoint) {
  console.error('Error: Could not locate the diff function patch point');
  console.error('The file structure may have changed. Manual patching may be needed.');
  process.exit(1);
}

console.log('Found diff patch point: ' + diffPoint.insertAfter);
console.log('  URI var:', diffPoint.leftUriVar, ' Provider var:', diffPoint.providerVar,
            ' Path var:', diffPoint.filePathVar, ' Content var:', diffPoint.contentVar);

const cv = diffPoint.contentVar;
const insertEnd = diffPoint.insertEnd;
if (diffPoint.alreadyApplied) {
  console.log('  -> Patch 2 (diff left-side CRLF) appears to be already applied, skipping.');
} else {
  const crlf_check = 'if(' + cv + '.includes("' + B + 'r' + B + 'n")){' + cv + '=' + cv + '.replace(' + RN_REGEX + ',' + N_STR + ');' + diffPoint.leftUriVar + '=' + diffPoint.providerVar + '.createFile(' + diffPoint.filePathVar + ',' + cv + ').uri}';

  // Splice at the exact index found. The insertAfter string is not unique in the
  // file (a second diff function later on can produce the same minified text),
  // so a plain content.replace() could patch the wrong site.
  content = content.slice(0, insertEnd) + crlf_check + content.slice(insertEnd);
  console.log('  -> Patch 2 applied: CRLF normalization in diff left-side');
}

// Backup and write
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
