/**
 * Executes Cursor's built-in file/shell tool calls (the `ExecServerMessage`
 * tool-args fields) and encodes the matching `ExecClientMessage` result. This is
 * what lets the agent actually read/write files and run commands in the
 * workspace instead of hanging forever waiting for a tool result the adapter
 * never sent.
 *
 * Field layout is verified against Cursor's own protobuf definitions (agent.v1):
 *   ReadArgs{1:path}            -> ReadResult{1:success{1:path,2:content,3:total_lines,4:file_size,6:truncated,10:size_bytes} | 4:file_not_found{1:path}}
 *   WriteArgs{1:path,2:file_text} -> WriteResult{1:success{1:path,2:lines_created,3:file_size} | 5:error{1:path,2:error}}
 *   LsArgs{1:path}              -> LsResult{1:success{1:directory_tree_root}}
 *   ShellArgs{1:command,2:working_directory} -> ShellResult{1:success{1:command,2:working_directory,3:exit_code,5:stdout,6:stderr}}
 *   GrepArgs{1:pattern,2:path,3:glob,4:output_mode,8:case_insensitive} -> GrepResult{1:success{1:pattern,2:path,3:output_mode,4:union{3:content}}}
 *
 * The ExecClientMessage echoes the request id (`f1` uint32 and `f15` string
 * exec_id) so Cursor can match the response to the pending tool call.
 *
 * @module dsh-connect-cursor-pro/tools
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { resolve, join, dirname, relative, sep } from 'node:path'
import { msg, get, getVar } from './pb.js'

const MAX_READ_CHARS = 200_000
const MAX_SHELL_OUTPUT = 100_000
const SKIP_DIRS = /node_modules|\.git|dist|build|\.next|coverage/i

/** Resolve a tool path against the workspace root; absolute paths pass through. */
function resolvePath(workspaceRoot, path) {
  if (!path) return workspaceRoot
  return resolve(workspaceRoot, String(path))
}

/** Shallow directory-tree node: one level (abs_path + child dirs + child files). */
function buildLsNode(absPath) {
  const st = statSync(absPath)
  if (!st.isDirectory()) {
    const name = absPath.split(/[\\/]/).pop() || absPath
    return msg({ 1: absPath, 3: [msg({ 1: name })], 4: true, 6: 1 })
  }
  const childrenDirs = []
  const childrenFiles = []
  for (const entry of readdirSync(absPath, { withFileTypes: true })) {
    const p = join(absPath, entry.name)
    try {
      if (statSync(p).isDirectory()) childrenDirs.push(msg({ 1: p }))
      else childrenFiles.push(msg({ 1: entry.name }))
    } catch {
      /* skip unreadable entry */
    }
  }
  return msg({ 1: absPath, 2: childrenDirs, 3: childrenFiles, 4: true, 6: childrenDirs.length + childrenFiles.length })
}

/** Convert a Cursor glob (`**`, `*`, `?`, `{a,b}`) to a path regex (or null). */
function globToRegex(glob) {
  if (!glob || glob === '*') return null
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end >= 0) {
        re += '(' + glob.slice(i + 1, end).split(',').join('|') + ')'
        i = end
      } else re += '\\{'
    } else if ('\\.[]()+-^$|'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}

/** Recursively list files under root (bounded), filtered by a glob on the relative path. */
function walkFiles(root, glob) {
  const re = globToRegex(glob)
  const out = []
  const stack = [root]
  while (stack.length && out.length < 2000) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.test(entry.name)) stack.push(p)
        continue
      }
      const rel = relative(root, p).split(sep).join('/')
      if (!re || re.test(rel)) out.push(p)
    }
  }
  return out
}

/** GrepFilesResult: file paths matching the glob (files_with_matches mode). */
function runGrepFiles(root, glob) {
  const files = walkFiles(root, glob)
  return msg({ 1: files, 2: files.length })
}

/** GrepContentResult: per-file matches using case-aware substring match. */
function runGrep(root, pattern, glob, caseInsensitive) {
  const needle = caseInsensitive ? pattern.toLowerCase() : pattern
  const matches = []
  let totalLines = 0
  let totalMatched = 0
  for (const file of walkFiles(root, glob)) {
    try {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      totalLines += lines.length
      const fileMatches = []
      lines.forEach((line, i) => {
        const hay = caseInsensitive ? line.toLowerCase() : line
        if (needle && hay.includes(needle)) {
          fileMatches.push(msg({ 1: i + 1, 2: line.slice(0, 500) }))
          totalMatched += 1
        }
      })
      if (fileMatches.length) matches.push(msg({ 1: file, 2: fileMatches }))
    } catch {
      /* skip unreadable file */
    }
  }
  return msg({ 1: matches, 2: totalLines, 3: totalMatched })
}

/**
 * Execute one `ExecServerMessage` (a decoded `AgentServerMessage.f2`) and return
 * the complete `ExecClientMessage` to send back, echoing the request id
 * (`f1` uint32 and `f15` string exec_id) so Cursor matches the response. Returns
 * null when the message carries no supported tool call.
 *
 * @param {Buffer} exec decoded ExecServerMessage
 * @param {string} workspaceRoot absolute workspace directory
 * @returns {Buffer | null} the ExecClientMessage encoding
 */
export function executeToolCall(exec, workspaceRoot) {
  const idNum = getVar(exec, 1)
  const execId = get(exec, 15)
  const idFields = {}
  if (idNum !== undefined) idFields[1] = idNum
  if (execId && execId.length) idFields[15] = execId

  // read_args (f7)
  const readArgs = get(exec, 7)
  if (readArgs) {
    const path = (get(readArgs, 1) || Buffer.alloc(0)).toString('utf8')
    const abs = resolvePath(workspaceRoot, path)
    try {
      let content = readFileSync(abs, 'utf8')
      let truncated = false
      if (content.length > MAX_READ_CHARS) {
        content = content.slice(0, MAX_READ_CHARS)
        truncated = true
      }
      const success = msg({
        1: path,
        2: content,
        3: content.split('\n').length,
        4: Buffer.byteLength(content),
        6: truncated ? 1 : 0,
        10: Buffer.byteLength(content),
      })
      return msg({ ...idFields, 7: msg({ 1: success }) })
    } catch {
      return msg({ ...idFields, 7: msg({ 4: msg({ 1: path }) }) })
    }
  }

  // write_args (f3)
  const writeArgs = get(exec, 3)
  if (writeArgs) {
    const path = (get(writeArgs, 1) || Buffer.alloc(0)).toString('utf8')
    const text = (get(writeArgs, 2) || Buffer.alloc(0)).toString('utf8')
    const abs = resolvePath(workspaceRoot, path)
    try {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text, 'utf8')
      const lines = text.length ? text.split('\n').length : 1
      return msg({ ...idFields, 3: msg({ 1: msg({ 1: path, 2: lines, 3: Buffer.byteLength(text) }) }) })
    } catch (error) {
      return msg({ ...idFields, 3: msg({ 5: msg({ 1: path, 2: String(error?.message || error) }) }) })
    }
  }

  // ls_args (f8)
  const lsArgs = get(exec, 8)
  if (lsArgs) {
    const path = (get(lsArgs, 1) || Buffer.alloc(0)).toString('utf8') || '.'
    const abs = resolvePath(workspaceRoot, path)
    try {
      return msg({ ...idFields, 8: msg({ 1: msg({ 1: buildLsNode(abs) }) }) })
    } catch (error) {
      return msg({ ...idFields, 8: msg({ 2: msg({ 1: String(error?.message || error) }) }) })
    }
  }

  // shell_args (f2)
  const shellArgs = get(exec, 2)
  if (shellArgs) {
    const command = (get(shellArgs, 1) || Buffer.alloc(0)).toString('utf8')
    const cwdArg = (get(shellArgs, 2) || Buffer.alloc(0)).toString('utf8')
    const cwd = cwdArg ? resolvePath(workspaceRoot, cwdArg) : workspaceRoot
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    try {
      stdout = execSync(command, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true })
    } catch (error) {
      exitCode = typeof error.status === 'number' ? error.status : 1
      if (error.stdout) stdout = String(error.stdout)
      stderr = error.stderr ? String(error.stderr) : String(error?.message || error)
    }
    if (stdout.length > MAX_SHELL_OUTPUT) stdout = stdout.slice(0, MAX_SHELL_OUTPUT)
    if (stderr.length > MAX_SHELL_OUTPUT) stderr = stderr.slice(0, MAX_SHELL_OUTPUT)
    return msg({ ...idFields, 2: msg({ 1: msg({ 1: command, 2: cwd, 3: exitCode, 5: stdout, 6: stderr }) }) })
  }

  // grep_args (f5)
  const grepArgs = get(exec, 5)
  if (grepArgs) {
    const pattern = (get(grepArgs, 1) || Buffer.alloc(0)).toString('utf8')
    const path = (get(grepArgs, 2) || Buffer.alloc(0)).toString('utf8') || '.'
    const glob = (get(grepArgs, 3) || Buffer.alloc(0)).toString('utf8')
    const outputMode = (get(grepArgs, 4) || Buffer.alloc(0)).toString('utf8') || 'content'
    const caseInsensitive = Boolean(getVar(grepArgs, 8))
    const abs = resolvePath(workspaceRoot, path)
    try {
      // GrepSuccess.workspace_results is `map<string, GrepUnionResult>`: encode it
      // as a repeated entry {1: key, 2: value}, not a bare GrepUnionResult.
      const mapEntry = (union) => msg({ 1: path, 2: union })
      if (outputMode === 'files_with_matches' || outputMode === 'files') {
        const files = runGrepFiles(abs, glob)
        const success = msg({ 1: pattern, 2: path, 3: outputMode, 4: [mapEntry(msg({ 2: files }))] })
        return msg({ ...idFields, 5: msg({ 1: success }) })
      }
      const content = runGrep(abs, pattern, glob, caseInsensitive)
      const success = msg({ 1: pattern, 2: path, 3: outputMode, 4: [mapEntry(msg({ 3: content }))] })
      return msg({ ...idFields, 5: msg({ 1: success }) })
    } catch (error) {
      return msg({ ...idFields, 5: msg({ 2: msg({ 1: String(error?.message || error) }) }) })
    }
  }

  return null
}
