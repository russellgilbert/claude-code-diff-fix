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
 * This script applies two patches:
 *   1. Edit function: normalizes \r\n to \n in both file content and edit strings
 *   2. Diff function: normalizes \r\n in the left-side temp file content
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
        candidates.push({ path: jsPath, version: ver, dir: entry });
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
  const match = content.match(/function\s+(\w+)\((\w+),(\w+)\)\{let\s+(\w+)=\2,\w+=\[\];if\(!\2/);
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
  const patchedMatch = content.match(/function\s+(\w+)\((\w+),(\w+)\)\{\2=\2\.replace\(/);
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

function findDiffPatchPoint(content) {
  // The diff function contains 'leftTempFileProvider.createFile' in a catch block.
  // We need to insert our CRLF check after the catch block closes.
  // Pattern: ...createFile(VAR,"").uri}let VAR=EDITFUNC(CONTENTVAR,...
  const ltfpIdx = content.indexOf('leftTempFileProvider.createFile');
  if (ltfpIdx === -1) return null;

  // Find the createFile(X,"").uri} that ends the catch block
  const searchArea = content.substring(ltfpIdx, ltfpIdx + 200);
  const catchEndMatch = searchArea.match(/createFile\((\w+),""\)\.uri\}/);
  if (!catchEndMatch) return null;

  const filePathVar = catchEndMatch[1]; // the variable holding the file path

  // Find the left URI variable and the createFile provider variable
  // Look backwards from ltfpIdx for: let URIVAR=XX.Uri.file(PATHVAR),CONTENTVAR="";
  const beforeArea = content.substring(ltfpIdx - 400, ltfpIdx);
  const uriMatch = beforeArea.match(/let\s+(\w+)=\w+\.Uri\.file\((\w+)\),([\w$]+)=""/);
  if (!uriMatch) return null;

  const leftUriVar = uriMatch[1]; // G in 2.1.71
  const contentVar = uriMatch[3]; // $ in 2.1.71, Z in 2.1.72

  // Find the provider variable: PROVIDER.createFile(VAR,"").uri
  const providerMatch = searchArea.match(/(\w+)\.createFile\(\w+,""\)\.uri\}/);
  if (!providerMatch) return null;

  const providerVar = providerMatch[1]; // v in our version

  // The exact insertion point string
  const insertAfter = catchEndMatch[0]; // e.g., createFile(K,"").uri}
  const insertAfterIdx = content.indexOf(insertAfter, ltfpIdx);

  return {
    filePathVar,
    leftUriVar,
    contentVar,
    providerVar,
    insertAfter,
    insertAfterIdx
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

  content = content.replace(oldStr, newStr);
  console.log('  -> Patch 1 applied: CRLF normalization in edit function');
}

// Find and apply patch 2
const diffPoint = findDiffPatchPoint(content);
if (!diffPoint) {
  console.error('Error: Could not locate the diff function patch point');
  console.error('The file structure may have changed. Manual patching may be needed.');
  process.exit(1);
}

console.log('Found diff patch point: ' + diffPoint.insertAfter);
console.log('  URI var:', diffPoint.leftUriVar, ' Provider var:', diffPoint.providerVar, ' Path var:', diffPoint.filePathVar);

// Check if patch 2 is already applied
const cv = diffPoint.contentVar;
const patch2Marker = diffPoint.insertAfter + 'if(' + cv + '.includes(';
if (content.includes(patch2Marker)) {
  console.log('  -> Patch 2 (diff left-side CRLF) appears to be already applied, skipping.');
} else {
  const crlf_check = 'if(' + cv + '.includes("' + B + 'r' + B + 'n")){' + cv + '=' + cv + '.replace(' + RN_REGEX + ',' + N_STR + ');' + diffPoint.leftUriVar + '=' + diffPoint.providerVar + '.createFile(' + diffPoint.filePathVar + ',' + cv + ').uri}';

  content = content.replace(
    diffPoint.insertAfter,
    diffPoint.insertAfter + crlf_check
  );
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

console.log('\nPatches applied successfully!');
console.log('Please reload VS Code (Ctrl+Shift+P -> "Developer: Reload Window") for changes to take effect.');
